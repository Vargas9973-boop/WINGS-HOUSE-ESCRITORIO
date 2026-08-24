-- Bug reportado en vivo: el consumo cubierto por el beneficio diario de
-- $100 de un empleado (process_sale, employee_consumption.benefit_amount)
-- es, en sustancia, lo mismo que "Consumo Jefes" en Merma -- insumo real
-- que sale del inventario sin que la venta lo recupere en efectivo -- pero
-- el módulo de Merma nunca lo mostraba: waste-renderer.js solo lee la
-- tabla `waste`, y el consumo por beneficio vive en `employee_consumption`,
-- una tabla completamente distinta que además tiene RLS sin policy anon
-- (ver comentario en db.js::getEmployeeDailyConsumption) -- el cliente no
-- puede ni leerla directo.
--
-- Confirmado con el usuario (no se adivina el diseño): esto se muestra como
-- una tercera categoría de SOLO LECTURA en Merma (KPI + fila en la tabla),
-- derivada automáticamente de las ventas -- NO se inserta una fila real en
-- `waste`, porque esa tabla siempre exige un insumo del inventario y su
-- guardado vuelve a descontar stock (create_waste_entry) -- el stock de esa
-- venta YA se descontó vía el trigger de recetas al crearse; insertar en
-- `waste` lo descontaría dos veces.
--
-- Dos piezas:
-- 1) employee_consumption gana `ref_id` (igual que sale_items.ref_id, sin
--    FK): permite resolver el producto real vendido y calcular su costo de
--    receta/insumo -- el mismo criterio de costo que ya usa
--    computeProfitability (db.js) para Food Cost -- en vez de solo mostrar
--    el precio de venta cubierto. process_sale se toca para poblarlo (firma
--    sin cambios, mismos 11 parámetros que 20260822240000 -- CREATE OR
--    REPLACE, no hace falta DROP).
-- 2) get_employee_benefit_consumption: RPC de solo lectura (SECURITY
--    DEFINER, porque employee_consumption no es legible directo) que
--    regresa las filas con benefit_amount > 0 de la sucursal actual.

ALTER TABLE public.employee_consumption
  ADD COLUMN IF NOT EXISTS ref_id bigint;

CREATE OR REPLACE FUNCTION public.process_sale(p_branch_id bigint, p_client_type text, p_items jsonb, p_payment_method text, p_amount_received numeric, p_discount numeric, p_opened_by text, p_employee_id bigint DEFAULT NULL::bigint, p_employee_sale_type text DEFAULT NULL::text, p_employee_extra_payment text DEFAULT NULL::text, p_is_delivery boolean DEFAULT false)
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

            -- ref_id agregado (única diferencia funcional de este archivo
            -- respecto a 20260822240000): permite que get_employee_benefit_consumption
            -- resuelva el costo real de receta del producto, en vez de solo
            -- el precio de venta cubierto por el beneficio.
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
        'benefit_used', v_benefit_amount,
        'employee_paid', v_employee_paid,
        'credit_amount', v_credit_amount,
        'benefit_available_before', v_benefit_available,
        'benefit_available_after', GREATEST(v_benefit_available - v_benefit_amount, 0)
    );

END;

$function$;

-- ==========================================================================
-- Reporte de solo lectura para Merma: filas de employee_consumption con
-- beneficio > 0 de la sucursal actual. p_from/p_to opcionales (NULL = sin
-- límite) para poder traer todo el histórico igual que getAllWaste sin
-- filtro de fecha, o acotar por mes/rango cuando se necesite.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.get_employee_benefit_consumption(p_branch_id bigint, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
 RETURNS TABLE(
   id bigint,
   employee_id bigint,
   employee_name text,
   sale_id bigint,
   consumption_date date,
   sale_created_at timestamptz,
   item_name text,
   item_type text,
   ref_id bigint,
   quantity numeric,
   unit_price numeric,
   total_amount numeric,
   benefit_amount numeric
 )
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (p_branch_id = ANY (COALESCE(public.current_visible_branch_ids(), ARRAY[]::bigint[]))) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  -- sale_created_at (join a sales) en vez de solo consumption_date: da la
  -- marca de tiempo real de la venta -- consumption_date es una fecha pura
  -- (sin hora), y mostrarla directo en la UI con fmtDate (que sí espera
  -- hora) la interpretaría en UTC y correría el día en México (mismo bug
  -- de fondo ya documentado en getUnifiedHistory).
  RETURN QUERY
  SELECT
    ec.id, ec.employee_id, ec.employee_name, ec.sale_id, ec.consumption_date,
    s.created_at, ec.item_name, ec.item_type, ec.ref_id, ec.quantity,
    ec.unit_price, ec.total_amount, ec.benefit_amount
  FROM public.employee_consumption ec
  JOIN public.sales s ON s.id = ec.sale_id
  WHERE ec.branch_id = p_branch_id
    AND COALESCE(ec.benefit_amount, 0) > 0
    AND (p_from IS NULL OR ec.consumption_date >= p_from)
    AND (p_to IS NULL OR ec.consumption_date <= p_to)
  ORDER BY ec.consumption_date DESC, ec.id DESC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_employee_benefit_consumption(bigint, date, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_employee_benefit_consumption(bigint, date, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_employee_benefit_consumption(bigint, date, date) TO authenticated;
