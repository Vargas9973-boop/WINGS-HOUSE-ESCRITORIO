-- Requerimiento nuevo (global, aplica a los 2 tenants existentes): permitir
-- combinar métodos de pago en una sola venta del módulo de Ventas/Público
-- General -- p.ej. $175 = $100 efectivo + $50 tarjeta + $25 transferencia.
-- Debe seguir siendo UNA sola fila en `sales` (no 3 ventas separadas), pero
-- cada rubro debe poder sumarse por separado en el corte de caja.
--
-- Diseño:
--   1) Tabla nueva `sale_payments`: un renglón por (venta, método, monto)
--      cuando el cajero usa el modal de pago combinado. Solo se llena desde
--      process_sale (SECURITY DEFINER) -- mismo patrón "RPC-only write" que
--      ya usa el resto de las tablas desde 20260822120000_rls_restrictive_phase1.
--      SELECT scoped a la sucursal propia, igual que `sales`/`cash_movements`.
--   2) `sales.payment_method` gana el valor sentinel 'mixto' (columna es
--      texto libre, sin CHECK -- ya convive con 'credito_nomina'/
--      'beneficio_empleado', ver 20260822010000). NO se toca para ventas
--      normales de un solo método: sale_payments solo se puebla cuando el
--      cajero explícitamente activa el modal, así que ninguna venta previa
--      ni ningún flujo de empleado ($100 diario / crédito) cambia de
--      comportamiento -- p_payments es opcional (DEFAULT NULL) y se
--      rechaza para client_type='employee' (ese ya tiene su propio motor
--      de reparto beneficio/efectivo/crédito, mezclarlo con split sería
--      ambiguo).
--   3) Sin "cambio": el cajero declara montos exactos por rubro y deben
--      sumar exacto al total (v_payments_sum <> v_total revienta la venta)
--      -- evita que $1 de descuadre en el split se pierda silencioso entre
--      dos rubros de caja.
--
-- Firma de process_sale cambia de 11 a 12 parámetros (se agrega
-- p_payments jsonb DEFAULT NULL al final) -- por el trap ya documentado
-- (postgres_create_or_replace_overload_trap), un CREATE OR REPLACE con un
-- parámetro nuevo NO reemplaza la función vieja, crea un overload duplicado
-- vivo. Se hace DROP FUNCTION explícito de la firma de 11 parámetros antes
-- de crear la de 12, y se re-otorgan los permisos a mano (una función nueva
-- nace con EXECUTE a PUBLIC por default -- confirmado real en
-- 20260822270000_fase2ab_revoke_public_full_sweep -- así que se revoca de
-- PUBLIC/anon y se deja solo `authenticated`, igual que la firma anterior).

-- ==========================================================================
-- 1. Tabla sale_payments
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.sale_payments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sale_id bigint NOT NULL REFERENCES public.sales(id) ON DELETE CASCADE,
  branch_id bigint NOT NULL,
  payment_method text NOT NULL CHECK (payment_method IN ('efectivo', 'tarjeta', 'transferencia')),
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sale_payments_sale_id ON public.sale_payments(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_payments_branch_id ON public.sale_payments(branch_id);

ALTER TABLE public.sale_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sale_payments_select_own_branch ON public.sale_payments;
CREATE POLICY sale_payments_select_own_branch ON public.sale_payments
  FOR SELECT TO authenticated
  USING (branch_id = public.current_branch_id());

-- Sin policy de insert/update/delete: solo process_sale (SECURITY DEFINER)
-- escribe aquí, igual que el resto de las tablas transaccionales.

-- ==========================================================================
-- 2. process_sale: agrega p_payments jsonb DEFAULT NULL
-- ==========================================================================
DROP FUNCTION IF EXISTS public.process_sale(bigint, text, jsonb, text, numeric, numeric, text, bigint, text, text, boolean);

CREATE FUNCTION public.process_sale(p_branch_id bigint, p_client_type text, p_items jsonb,
  p_payment_method text, p_amount_received numeric, p_discount numeric, p_opened_by text,
  p_employee_id bigint DEFAULT NULL, p_employee_sale_type text DEFAULT NULL,
  p_employee_extra_payment text DEFAULT NULL, p_is_delivery boolean DEFAULT false,
  p_payments jsonb DEFAULT NULL)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$

DECLARE
    v_sale_id bigint;
    v_folio text;

    v_total numeric := 0;
    v_item jsonb;
    v_item_total numeric := 0;
    v_current_stock numeric;
    v_employee_name text;

    v_today date;
    v_today_consumed numeric := 0;
    v_benefit_available numeric;

    v_benefit_amount numeric := 0;
    v_employee_paid numeric := 0;
    v_credit_amount numeric := 0;
    v_extra_amount numeric := 0;

    v_benefit_remaining numeric := 0;
    v_paid_remaining numeric := 0;
    v_credit_remaining numeric := 0;

    v_item_benefit numeric := 0;
    v_item_paid numeric := 0;
    v_item_credit numeric := 0;

    v_week_start date;
    v_existing_credit numeric := 0;

    v_benefit_before_out numeric := NULL;
    v_benefit_after_out numeric := NULL;

    v_status text := 'completada';

    v_benefit_enabled boolean;
    v_benefit_daily_amount numeric;
    v_weekly_credit_enabled boolean;
    v_weekly_credit_limit numeric;
    v_setting_value text;

    v_payment jsonb;
    v_payments_sum numeric := 0;
    v_final_payment_method text;
    v_final_amount_received numeric;

BEGIN

    IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
        RAISE EXCEPTION 'branch mismatch';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch_id) THEN
        RAISE EXCEPTION 'La sucursal % no existe.', p_branch_id;
    END IF;

    SELECT value INTO v_setting_value
      FROM public.settings
     WHERE branch_id = p_branch_id AND key = 'benefit_enabled';
    v_benefit_enabled := COALESCE(v_setting_value, 'true') <> 'false';

    SELECT value INTO v_setting_value
      FROM public.settings
     WHERE branch_id = p_branch_id AND key = 'benefit_daily_amount';
    v_benefit_daily_amount :=
      CASE WHEN v_setting_value ~ '^[0-9]+(\.[0-9]+)?$' AND v_setting_value::numeric > 0
           THEN v_setting_value::numeric
           ELSE 100
      END;

    SELECT value INTO v_setting_value
      FROM public.settings
     WHERE branch_id = p_branch_id AND key = 'weekly_credit_enabled';
    v_weekly_credit_enabled := COALESCE(v_setting_value, 'true') <> 'false';

    SELECT value INTO v_setting_value
      FROM public.settings
     WHERE branch_id = p_branch_id AND key = 'weekly_credit_limit';
    v_weekly_credit_limit :=
      CASE WHEN v_setting_value ~ '^[0-9]+(\.[0-9]+)?$' AND v_setting_value::numeric > 0
           THEN v_setting_value::numeric
           ELSE 500
      END;

    v_benefit_available := v_benefit_daily_amount;

    v_today :=
        (now() AT TIME ZONE 'America/Mexico_City')::date;

    v_week_start := date_trunc('week', v_today)::date;

    IF p_items IS NULL
       OR jsonb_array_length(p_items) = 0
    THEN
        RAISE EXCEPTION 'La venta no contiene artículos.';
    END IF;

    IF p_client_type = 'employee'
       AND p_employee_id IS NULL
    THEN
        RAISE EXCEPTION
            'La venta de empleado requiere seleccionar un empleado.';
    END IF;

    IF p_employee_id IS NOT NULL THEN

        SELECT name
        INTO v_employee_name
        FROM public.employees
        WHERE id = p_employee_id
          AND active = true
          AND branch_id = p_branch_id;

        IF v_employee_name IS NULL THEN
            RAISE EXCEPTION
                'El empleado seleccionado no existe, está inactivo o no pertenece a esta sucursal.';
        END IF;

    END IF;

    IF p_client_type = 'employee'
       AND p_employee_sale_type = 'daily_100'
       AND NOT v_benefit_enabled
    THEN
        RAISE EXCEPTION 'El beneficio diario está deshabilitado en Ajustes.';
    END IF;

    IF p_client_type = 'employee'
       AND p_employee_sale_type = 'daily_100'
    THEN

        PERFORM pg_advisory_xact_lock(
            hashtext(
                'employee_daily_benefit_' ||
                p_branch_id::text || '_' ||
                p_employee_id::text
            )
        );

    END IF;

    FOR v_item IN
        SELECT *
        FROM jsonb_array_elements(p_items)
    LOOP

        IF COALESCE(
            v_item->>'item_type',
            'product'
        ) = 'product'

        AND NULLIF(
            v_item->>'ref_id',
            ''
        ) IS NOT NULL
        THEN

            SELECT stock
            INTO v_current_stock
            FROM public.products
            WHERE id = (v_item->>'ref_id')::bigint;

            IF v_current_stock IS NOT NULL
               AND v_current_stock <
                   (v_item->>'quantity')::numeric
            THEN

                RAISE EXCEPTION
                    '"%" no tiene existencia disponible.',
                    v_item->>'name';

            END IF;

        END IF;

        v_item_total :=
            ROUND(
                (v_item->>'unit_price')::numeric
                *
                (v_item->>'quantity')::numeric,
                2
            );

        v_total :=
            v_total + v_item_total;

    END LOOP;

    v_total :=
        ROUND(
            GREATEST(
                v_total,
                0
            ),
            2
        );

    -- ================================================================
    -- PAGO COMBINADO
    -- p_payments (opcional): [{method, amount}, ...] con los rubros reales
    -- de caja. Solo aplica a público general -- el empleado ya tiene su
    -- propio reparto beneficio/efectivo/crédito más abajo. Sin "cambio":
    -- la suma debe cuadrar exacto con v_total.
    -- ================================================================
    IF p_payments IS NOT NULL AND jsonb_array_length(p_payments) > 0 THEN

        IF p_client_type = 'employee' THEN
            RAISE EXCEPTION 'El pago combinado no aplica a ventas de empleado.';
        END IF;

        FOR v_payment IN
            SELECT * FROM jsonb_array_elements(p_payments)
        LOOP

            IF COALESCE(v_payment->>'method', '') NOT IN ('efectivo', 'tarjeta', 'transferencia') THEN
                RAISE EXCEPTION 'Método de pago combinado no válido: %', COALESCE(v_payment->>'method', '(vacío)');
            END IF;

            IF COALESCE((v_payment->>'amount')::numeric, 0) <= 0 THEN
                RAISE EXCEPTION 'Cada método de pago combinado debe tener un monto mayor a $0.';
            END IF;

            v_payments_sum := v_payments_sum + ROUND((v_payment->>'amount')::numeric, 2);

        END LOOP;

        IF v_payments_sum <> v_total THEN
            RAISE EXCEPTION
                'La suma de los métodos de pago ($%) no coincide con el total de la venta ($%).',
                v_payments_sum, v_total;
        END IF;

        v_final_payment_method := 'mixto';
        v_final_amount_received := v_total;

    ELSE

        v_final_payment_method := p_payment_method;
        v_final_amount_received := p_amount_received;

    END IF;

    IF p_client_type = 'employee' THEN

        SELECT COALESCE(
            SUM(
                ROUND(
                    COALESCE(benefit_amount, 0),
                    2
                )
            ),
            0
        )
        INTO v_today_consumed
        FROM public.employee_consumption
        WHERE employee_id = p_employee_id
          AND branch_id = p_branch_id
          AND consumption_date = v_today;

        v_benefit_available :=
            ROUND(
                GREATEST(
                    v_benefit_daily_amount - v_today_consumed,
                    0
                ),
                2
            );

        IF p_employee_sale_type = 'daily_100' THEN

            v_benefit_amount :=
                ROUND(
                    LEAST(
                        v_total,
                        v_benefit_available
                    ),
                    2
                );

            v_extra_amount :=
                ROUND(
                    GREATEST(
                        v_total - v_benefit_amount,
                        0
                    ),
                    2
                );

            IF v_extra_amount > 0 THEN

                IF p_employee_extra_payment
                   NOT IN ('cash', 'credit')
                THEN

                    RAISE EXCEPTION
                        'La venta excede el beneficio disponible. Selecciona Efectivo o Crédito para el excedente.';

                END IF;

                IF p_employee_extra_payment = 'cash' THEN

                    v_employee_paid :=
                        v_extra_amount;

                ELSE

                    v_credit_amount :=
                        v_extra_amount;

                END IF;

            END IF;

        ELSIF p_employee_sale_type = 'takeaway_credit' THEN

            v_benefit_amount := 0;
            v_credit_amount := v_total;

        ELSE

            RAISE EXCEPTION
                'Tipo de consumo de empleado no válido.';

        END IF;

    END IF;

    v_benefit_amount :=
        ROUND(
            COALESCE(v_benefit_amount, 0),
            2
        );

    v_employee_paid :=
        ROUND(
            COALESCE(v_employee_paid, 0),
            2
        );

    v_credit_amount :=
        ROUND(
            COALESCE(v_credit_amount, 0),
            2
        );

    IF v_credit_amount > 0 THEN

        IF NOT v_weekly_credit_enabled THEN
            RAISE EXCEPTION 'El crédito semanal está deshabilitado en Ajustes.';
        END IF;

        SELECT COALESCE(credit_amount, 0)
          INTO v_existing_credit
          FROM public.employee_weekly_credit
         WHERE employee_id = p_employee_id
           AND branch_id = p_branch_id
           AND week_start = v_week_start;

        IF COALESCE(v_existing_credit, 0) + v_credit_amount > v_weekly_credit_limit THEN
            RAISE EXCEPTION
                'El crédito semanal excede el tope permitido ($%). Disponible: $%.',
                v_weekly_credit_limit,
                GREATEST(v_weekly_credit_limit - COALESCE(v_existing_credit, 0), 0);
        END IF;

    END IF;

    IF p_client_type = 'employee' THEN
        v_benefit_before_out := v_benefit_available;
        v_benefit_after_out := GREATEST(v_benefit_available - v_benefit_amount, 0);
    END IF;

    v_benefit_remaining := v_benefit_amount;
    v_paid_remaining := v_employee_paid;
    v_credit_remaining := v_credit_amount;

    v_folio := public.wh_next_folio(p_branch_id);

    IF p_is_delivery OR p_client_type = 'Llevar' THEN
        v_status := 'abierta';
    END IF;

    INSERT INTO public.sales (
        branch_id,
        folio,
        client_type,
        employee_id,
        employee_name,
        employee_sale_type,
        payment_method,
        amount_received,
        total,
        status,
        table_number,
        opened_by,
        employee_benefit_before,
        employee_benefit_after
    )
    VALUES (
        p_branch_id,
        v_folio,
        p_client_type,
        p_employee_id,
        v_employee_name,
        p_employee_sale_type,
        v_final_payment_method,
        v_final_amount_received,
        v_total,
        v_status,
        NULL,
        p_opened_by,
        v_benefit_before_out,
        v_benefit_after_out
    )
    RETURNING id INTO v_sale_id;

    IF p_payments IS NOT NULL AND jsonb_array_length(p_payments) > 0 THEN
        FOR v_payment IN
            SELECT * FROM jsonb_array_elements(p_payments)
        LOOP
            INSERT INTO public.sale_payments (
                sale_id,
                branch_id,
                payment_method,
                amount
            )
            VALUES (
                v_sale_id,
                p_branch_id,
                v_payment->>'method',
                ROUND((v_payment->>'amount')::numeric, 2)
            );
        END LOOP;
    END IF;

    FOR v_item IN
        SELECT *
        FROM jsonb_array_elements(p_items)
    LOOP

        v_item_total :=
            ROUND(
                (v_item->>'unit_price')::numeric
                *
                (v_item->>'quantity')::numeric,
                2
            );

        INSERT INTO public.sale_items (
            sale_id,
            ref_id,
            item_type,
            name,
            unit_price,
            quantity,
            subtotal
        )
        VALUES (
            v_sale_id,
            NULLIF(
                v_item->>'ref_id',
                ''
            )::bigint,

            COALESCE(
                v_item->>'item_type',
                'product'
            ),

            v_item->>'name',

            ROUND(
                (v_item->>'unit_price')::numeric,
                2
            ),

            (v_item->>'quantity')::int,

            v_item_total
        );

        IF COALESCE(
            v_item->>'item_type',
            'product'
        ) = 'product'

        AND NULLIF(
            v_item->>'ref_id',
            ''
        ) IS NOT NULL
        THEN

            UPDATE public.products
            SET stock =
                GREATEST(
                    stock -
                    (v_item->>'quantity')::numeric,
                    0
                )
            WHERE id =
                (v_item->>'ref_id')::bigint

              AND stock IS NOT NULL;

        END IF;

        IF p_client_type = 'employee' THEN

            IF v_benefit_remaining > 0 THEN

                v_item_benefit :=
                    ROUND(
                        LEAST(
                            v_item_total,
                            v_benefit_remaining
                        ),
                        2
                    );

            ELSE

                v_item_benefit := 0;

            END IF;

            IF v_paid_remaining > 0 THEN

                v_item_paid :=
                    ROUND(
                        LEAST(
                            GREATEST(
                                v_item_total -
                                v_item_benefit,
                                0
                            ),
                            v_paid_remaining
                        ),
                        2
                    );

            ELSE

                v_item_paid := 0;

            END IF;

            v_item_credit :=
                ROUND(
                    GREATEST(
                        v_item_total -
                        v_item_benefit -
                        v_item_paid,
                        0
                    ),
                    2
                );

            v_benefit_remaining :=
                ROUND(
                    GREATEST(
                        v_benefit_remaining -
                        v_item_benefit,
                        0
                    ),
                    2
                );

            v_paid_remaining :=
                ROUND(
                    GREATEST(
                        v_paid_remaining -
                        v_item_paid,
                        0
                    ),
                    2
                );

            v_credit_remaining :=
                ROUND(
                    GREATEST(
                        v_credit_remaining -
                        v_item_credit,
                        0
                    ),
                    2
                );

            INSERT INTO public.employee_consumption (
                employee_id,
                employee_name,
                sale_id,
                consumption_date,
                item_name,
                item_type,
                ref_id,
                quantity,
                unit_price,
                total_amount,
                benefit_amount,
                employee_paid,
                payment_method,
                is_credit,
                credit_week_start,
                branch_id
            )
            VALUES (
                p_employee_id,
                v_employee_name,
                v_sale_id,
                v_today,
                v_item->>'name',

                COALESCE(
                    v_item->>'item_type',
                    'product'
                ),

                NULLIF(
                    v_item->>'ref_id',
                    ''
                )::bigint,

                (v_item->>'quantity')::numeric,

                ROUND(
                    (v_item->>'unit_price')::numeric,
                    2
                ),

                v_item_total,

                v_item_benefit,

                v_item_paid,

                CASE
                    WHEN v_item_credit > 0
                        THEN 'credito'

                    WHEN v_item_paid > 0
                        THEN 'efectivo'

                    ELSE 'beneficio'
                END,

                v_item_credit > 0,

                CASE
                    WHEN v_item_credit > 0
                    THEN date_trunc(
                        'week',
                        v_today
                    )::date

                    ELSE NULL
                END,

                p_branch_id
            );

        END IF;

    END LOOP;

    IF p_client_type = 'employee'
       AND (
           v_credit_amount > 0
           OR v_benefit_amount > 0
       )
    THEN

        INSERT INTO public.employee_weekly_credit (
            employee_id,
            employee_name,
            week_start,
            benefit_used,
            credit_amount,
            paid_amount,
            payroll_deducted,
            branch_id
        )
        VALUES (
            p_employee_id,
            v_employee_name,
            v_week_start,
            v_benefit_amount,
            v_credit_amount,
            v_employee_paid,
            false,
            p_branch_id
        )

        ON CONFLICT (
            employee_id,
            week_start
        )

        DO UPDATE SET

            benefit_used =
                public.employee_weekly_credit.benefit_used
                +
                EXCLUDED.benefit_used,

            credit_amount =
                public.employee_weekly_credit.credit_amount
                +
                EXCLUDED.credit_amount,

            paid_amount =
                public.employee_weekly_credit.paid_amount
                +
                EXCLUDED.paid_amount,

            updated_at = now();

    END IF;

    RETURN json_build_object(
        'id', v_sale_id,
        'folio', v_folio,
        'employee_id', p_employee_id,
        'employee_name', v_employee_name,
        'employee_sale_type', p_employee_sale_type,
        'total', v_total,
        'payment_method', v_final_payment_method,
        'benefit_used', v_benefit_amount,
        'employee_paid', v_employee_paid,
        'credit_amount', v_credit_amount,
        'benefit_available_before', v_benefit_available,
        'benefit_available_after', GREATEST(v_benefit_available - v_benefit_amount, 0)
    );

END;

$function$;

REVOKE EXECUTE ON FUNCTION public.process_sale(bigint, text, jsonb, text, numeric, numeric, text, bigint, text, text, boolean, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.process_sale(bigint, text, jsonb, text, numeric, numeric, text, bigint, text, text, boolean, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.process_sale(bigint, text, jsonb, text, numeric, numeric, text, bigint, text, text, boolean, jsonb) TO authenticated;

-- ==========================================================================
-- 3. get_sale_payments: breakdown de pago combinado para una o varias
--    ventas. Usado por el corte de caja (getCorteResumen) para sumar los
--    rubros reales de las ventas 'mixto' del día -- SELECT directo a
--    sale_payments también funcionaría (tiene policy propia), pero se
--    expone como RPC por consistencia con get_sale_items_with_modifiers
--    (mismo patrón: p_branch_id + array de ids) y para no depender de que
--    PostgREST permita .in() con arrays grandes sin límite.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.get_sale_payments(p_branch_id bigint, p_sale_ids bigint[])
 RETURNS TABLE(sale_id bigint, payment_method text, amount numeric)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
  SELECT sp.sale_id, sp.payment_method, sp.amount
  FROM public.sale_payments sp
  WHERE sp.branch_id = p_branch_id
    AND sp.sale_id = ANY(p_sale_ids);
$$;

REVOKE EXECUTE ON FUNCTION public.get_sale_payments(bigint, bigint[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_sale_payments(bigint, bigint[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_sale_payments(bigint, bigint[]) TO authenticated;
