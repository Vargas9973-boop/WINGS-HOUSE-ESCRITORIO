-- Punto 2: wh_next_folio() (caja negra) tenía dos bugs reales de aislamiento:
--   1. to_char(now(), 'YYYYMMDD') usa la zona de sesión del servidor (UTC en
--      Supabase), no America/Mexico_City -- mismo patrón ya corregido toda
--      esta semana (Historial/Corte/Nómina/Asistencia). El folio podía
--      "adelantarse" de fecha hasta 6 horas antes de la medianoche real.
--   2. folio_counters NUNCA usó su propia columna branch_id (ya existía,
--      agregada en 20260815070000_branch_and_ticket_schema.sql, con
--      DEFAULT) -- el ON CONFLICT (day) es un contador GLOBAL compartido
--      por TODAS las sucursales. Con una sola sucursal esto es invisible;
--      con una segunda, ambas pelearían el mismo folio del día (números
--      cruzados entre sucursales, más contención de lock entre tenants
--      distintos en la misma fila).
-- Se agrega p_branch_id (obligatorio, sin DEFAULT -- mismo criterio que
-- p_branch_id en process_sale/create_product/etc.: fallar fuerte en vez de
-- caer en silencio a la sucursal por defecto). Cambia la unicidad de
-- (day) a (day, branch_id) -- constraint vieja encontrada dinámicamente,
-- no adivinada, mismo patrón que 20260822050000_settings_branch_isolation.sql.

DO $$
DECLARE
  v_conname text;
BEGIN
  SELECT con.conname INTO v_conname
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'folio_counters'
    AND con.contype IN ('u', 'p')
    AND (
      SELECT array_agg(attname::text ORDER BY attnum)
      FROM pg_attribute
      WHERE attrelid = con.conrelid AND attnum = ANY(con.conkey)
    ) = ARRAY['day']::text[]
  LIMIT 1;

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.folio_counters DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

-- Backfill: filas existentes (branch_id ya viene con DEFAULT desde 2026-08-15,
-- no debería haber NULL, pero por si acaso) a la primera sucursal real.
UPDATE public.folio_counters SET branch_id = (SELECT id FROM public.branches ORDER BY id LIMIT 1)
WHERE branch_id IS NULL;

ALTER TABLE public.folio_counters ALTER COLUMN branch_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'folio_counters_day_branch_unique'
  ) THEN
    ALTER TABLE public.folio_counters
      ADD CONSTRAINT folio_counters_day_branch_unique UNIQUE (day, branch_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.wh_next_folio(p_branch_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_day text := to_char(now() AT TIME ZONE 'America/Mexico_City', 'YYYYMMDD');
  v_seq int;
BEGIN
  IF p_branch_id IS NULL THEN
    RAISE EXCEPTION 'p_branch_id requerido';
  END IF;

  INSERT INTO public.folio_counters (day, last_seq, branch_id)
  VALUES (v_day, 1, p_branch_id)
  ON CONFLICT (day, branch_id) DO UPDATE SET last_seq = public.folio_counters.last_seq + 1
  RETURNING last_seq INTO v_seq;

  RETURN v_day || '-' || lpad(v_seq::text, 4, '0');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.wh_next_folio(bigint) TO anon, authenticated;

-- process_sale/close_table llaman a wh_next_folio() internamente -- se
-- actualiza el único punto de esa llamada en cada una (public.wh_next_folio()
-- -> public.wh_next_folio(p_branch_id)); el resto de ambas funciones queda
-- idéntico a como quedó en 20260822040000/20260821050000, así que
-- CREATE OR REPLACE es seguro aquí (misma firma externa, no crea sobrecarga).
CREATE OR REPLACE FUNCTION public.close_table(p_branch_id bigint, p_sale_id bigint, p_discount numeric, p_payment_method text, p_amount_received numeric, p_opened_by text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_folio text;
    v_subtotal numeric;
    v_discount numeric;
    v_total numeric;
    v_status character varying;
    v_item RECORD;
BEGIN
    IF p_sale_id IS NULL OR p_sale_id <= 0 THEN
        RAISE EXCEPTION 'ID de comanda inválido.';
    END IF;

    IF p_payment_method IS NULL OR NOT (p_payment_method IN ('efectivo', 'tarjeta', 'transferencia')) THEN
        RAISE EXCEPTION 'Selecciona un método de pago válido (efectivo, tarjeta o transferencia).';
    END IF;

    SELECT s.status
      INTO v_status
      FROM public.sales s
     WHERE s.id = p_sale_id
       AND s.branch_id = p_branch_id
     FOR UPDATE;

    IF v_status IS NULL THEN
        RAISE EXCEPTION 'La comanda no existe en esta sucursal.';
    END IF;

    IF v_status <> 'abierta' THEN
        RAISE EXCEPTION 'La comanda ya fue cerrada o cancelada.';
    END IF;

    SELECT COALESCE(SUM(si.subtotal), 0)
      INTO v_subtotal
      FROM public.sale_items si
     WHERE si.sale_id = p_sale_id;

    v_discount := GREATEST(COALESCE(p_discount, 0), 0);
    v_total := GREATEST(v_subtotal - v_discount, 0);

    IF p_payment_method = 'efectivo' THEN
        IF p_amount_received IS NULL THEN
            RAISE EXCEPTION 'Indica el monto recibido en efectivo.';
        END IF;
        IF p_amount_received < v_total THEN
            RAISE EXCEPTION 'El monto recibido ($%) es menor al total ($%).',
                p_amount_received, v_total;
        END IF;
    END IF;

    FOR v_item IN
        SELECT si.ref_id, si.quantity, si.name
          FROM public.sale_items si
         WHERE si.sale_id = p_sale_id
           AND si.item_type = 'product'
           AND si.ref_id IS NOT NULL
    LOOP
        UPDATE public.products
           SET stock = stock - v_item.quantity
         WHERE id = v_item.ref_id
           AND stock IS NOT NULL
           AND stock >= v_item.quantity;

        IF NOT FOUND THEN
            IF EXISTS (
                SELECT 1
                  FROM public.products p
                 WHERE p.id = v_item.ref_id
                   AND p.active = true
                   AND p.stock IS NULL
            ) THEN
                NULL;
            ELSE
                RAISE EXCEPTION 'No hay existencia suficiente para "%".', v_item.name;
            END IF;
        END IF;
    END LOOP;

    v_folio := public.wh_next_folio(p_branch_id);

    UPDATE public.sales
       SET folio = v_folio,
           total = v_total,
           status = 'completada',
           payment_method = p_payment_method,
           amount_received = p_amount_received,
           opened_by = COALESCE(opened_by, p_opened_by)
     WHERE id = p_sale_id;

    RETURN json_build_object(
        'id', p_sale_id,
        'folio', v_folio,
        'subtotal', v_subtotal,
        'discount', v_discount,
        'total', v_total
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.close_table(bigint, bigint, numeric, text, numeric, text) TO anon;

-- process_sale: mismo cambio (wh_next_folio() -> wh_next_folio(p_branch_id)),
-- resto idéntico a 20260822040000_employee_tables_branch_isolation.sql.
CREATE OR REPLACE FUNCTION public.process_sale(
  p_branch_id bigint,
  p_client_type text,
  p_items jsonb,
  p_payment_method text,
  p_amount_received numeric,
  p_discount numeric,
  p_opened_by text,
  p_employee_id bigint DEFAULT NULL::bigint,
  p_employee_sale_type text DEFAULT NULL::text,
  p_employee_extra_payment text DEFAULT NULL::text,
  p_is_delivery boolean DEFAULT false,
  p_benefit_enabled boolean DEFAULT true,
  p_benefit_daily_amount numeric DEFAULT 100,
  p_weekly_credit_enabled boolean DEFAULT true,
  p_weekly_credit_limit numeric DEFAULT 500
)
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
    v_benefit_available numeric := COALESCE(p_benefit_daily_amount, 100);

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

BEGIN

    IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch_id) THEN
        RAISE EXCEPTION 'La sucursal % no existe.', p_branch_id;
    END IF;

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
       AND NOT p_benefit_enabled
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
                    COALESCE(p_benefit_daily_amount, 100) - v_today_consumed,
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

        IF NOT p_weekly_credit_enabled THEN
            RAISE EXCEPTION 'El crédito semanal está deshabilitado en Ajustes.';
        END IF;

        SELECT COALESCE(credit_amount, 0)
          INTO v_existing_credit
          FROM public.employee_weekly_credit
         WHERE employee_id = p_employee_id
           AND branch_id = p_branch_id
           AND week_start = v_week_start;

        IF COALESCE(v_existing_credit, 0) + v_credit_amount > COALESCE(p_weekly_credit_limit, 500) THEN
            RAISE EXCEPTION
                'El crédito semanal excede el tope permitido ($%). Disponible: $%.',
                COALESCE(p_weekly_credit_limit, 500),
                GREATEST(COALESCE(p_weekly_credit_limit, 500) - COALESCE(v_existing_credit, 0), 0);
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
        p_payment_method,
        p_amount_received,
        v_total,
        v_status,
        NULL,
        p_opened_by,
        v_benefit_before_out,
        v_benefit_after_out
    )
    RETURNING id INTO v_sale_id;

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
        'benefit_used', v_benefit_amount,
        'employee_paid', v_employee_paid,
        'credit_amount', v_credit_amount,
        'benefit_available_before', v_benefit_available,
        'benefit_available_after', GREATEST(v_benefit_available - v_benefit_amount, 0)
    );

END;

$function$;

GRANT EXECUTE ON FUNCTION public.process_sale(bigint, text, jsonb, text, numeric, numeric, text, bigint, text, text, boolean, boolean, numeric, boolean, numeric) TO anon, authenticated;
