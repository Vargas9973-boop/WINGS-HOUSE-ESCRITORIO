-- Aislamiento real por sucursal (no el de confianza -- ver auditoría
-- 2026-08-22): employee_consumption y employee_weekly_credit nunca
-- tuvieron branch_id, a diferencia de payroll_deductions/payroll_history
-- (ya cerrado en 20260821110000_payroll_deductions_history_branch_id.sql).
-- Ambas las escribe process_sale -- se toca de nuevo con la misma
-- autorización ya dada para los parámetros de beneficio/crédito
-- (20260822010000), agregando branch_id explícito a los 2 INSERT.
--
-- payroll_weeks (bono semanal) también carece de branch_id, pero su único
-- escritor es set_payroll_bonus, un RPC "caja negra" nunca versionado en
-- este repo (igual que register_attendance/set_setting) -- no se
-- reescribe a ciegas. Se le agrega la columna (DEFAULT a la única
-- sucursal real hoy) y se deja el lado de lectura listo para filtrar,
-- pero el INSERT de set_payroll_bonus seguirá cayendo en el DEFAULT hasta
-- tener su definición real.

ALTER TABLE public.employee_consumption
  ADD COLUMN IF NOT EXISTS branch_id bigint REFERENCES public.branches(id);
ALTER TABLE public.employee_weekly_credit
  ADD COLUMN IF NOT EXISTS branch_id bigint REFERENCES public.branches(id);
ALTER TABLE public.payroll_weeks
  ADD COLUMN IF NOT EXISTS branch_id bigint REFERENCES public.branches(id);

-- Backfill: employee_consumption/employee_weekly_credit ya traen
-- employee_id, que sí es branch-scoped (cada empleado pertenece a una sola
-- sucursal) -- se infiere de ahí. payroll_weeks también tiene employee_id.
UPDATE public.employee_consumption t
SET branch_id = e.branch_id
FROM public.employees e
WHERE t.employee_id = e.id AND t.branch_id IS NULL;

UPDATE public.employee_weekly_credit t
SET branch_id = e.branch_id
FROM public.employees e
WHERE t.employee_id = e.id AND t.branch_id IS NULL;

UPDATE public.payroll_weeks t
SET branch_id = e.branch_id
FROM public.employees e
WHERE t.employee_id = e.id AND t.branch_id IS NULL;

-- Lo que no se pudo inferir (employee_id NULL/huérfano) cae en la única
-- sucursal real hoy, igual que el resto de los backfills de esta semana.
UPDATE public.employee_consumption SET branch_id = 1 WHERE branch_id IS NULL;
UPDATE public.employee_weekly_credit SET branch_id = 1 WHERE branch_id IS NULL;
UPDATE public.payroll_weeks SET branch_id = 1 WHERE branch_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_employee_consumption_branch ON public.employee_consumption (branch_id);
CREATE INDEX IF NOT EXISTS idx_employee_weekly_credit_branch ON public.employee_weekly_credit (branch_id);
CREATE INDEX IF NOT EXISTS idx_payroll_weeks_branch ON public.payroll_weeks (branch_id);

-- process_sale: mismos parámetros/lógica que 20260822010000, único cambio
-- es mandar branch_id explícito en los 2 INSERT (antes dependían del
-- DEFAULT de la columna) y filtrar por branch_id al leer consumo/crédito
-- ya acumulados (redundante hoy porque employee_id ya acota la sucursal,
-- pero consistente con el resto del repo y a prueba de que employee_id
-- deje de ser suficiente algún día).
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

    -- Estado de la venta: 'abierta' si es domicilio o "para llevar" desde la
    -- web (se cierra hasta que comandaSetDeliveryStatus/el KDS la marcan
    -- entregada), 'completada' en cualquier otro caso -- igual que
    -- 20260819090300_fix_web_takeout_stays_open.sql.
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

    v_folio := public.wh_next_folio();

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
