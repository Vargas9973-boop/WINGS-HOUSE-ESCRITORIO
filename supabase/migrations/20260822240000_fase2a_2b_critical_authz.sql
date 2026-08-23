-- Fase 2A + 2B del audit multi-tenant: las funciones CRÍTICAS (lectura que
-- expone datos reales de otro tenant si se manda otro branch_id; escritura
-- que mueve dinero/nómina/RRHH/permisos de otro tenant) dejan de confiar en
-- el p_branch_id que manda el cliente para AUTORIZAR -- se sigue aceptando
-- como parámetro (no se toca la firma, cero cambios en db.js/wing-house-web)
-- pero se valida contra la sesión real antes de usarlo. Patrón:
--   - Lecturas: p_branch_id = ANY(current_visible_branch_ids()) -- respeta
--     el rol dueño (lectura multi-sucursal dentro del mismo tenant).
--   - Escrituras: p_branch_id = current_branch_id() -- sigue siendo una
--     sola sucursal incluso para el dueño (ver
--     20260822170000_owner_role_multibranch_readonly.sql).
-- Todas pasan de GRANT a anon+authenticated a SOLO authenticated.
--
-- Hallazgo no buscado (introspección en vivo antes de escribir esto, ver
-- tmp_introspect_anon_rpcs): 23 de las ~67 funciones anon-callable que
-- db.js llama activamente NO EXISTEN hoy en la base -- confirmado con
-- pg_proc, count=0 cada una (update_employee, remove_employee,
-- save_fingerprint, clear_fingerprint, update_sale_payment_status,
-- set_cash_cut_fondo_inicial, close_cash_cut, create_cash_movement,
-- remove_cash_movement, y más). Sus migraciones originales SÍ tienen el
-- CREATE FUNCTION y están marcadas como aplicadas en el historial remoto
-- -- no se pudo determinar la causa exacta (no hay ningún DROP FUNCTION
-- que las mencione, ni un DROP TABLE ... CASCADE que explique la
-- desaparición). De las 23, 9 son CRÍTICAS (mueven caja/nómina/RRHH) y se
-- recrean aquí mismo, ya con el guard nuevo desde el origen -- no tiene
-- caso crearlas inseguras primero. Las 14 restantes (MEDIO: inventario,
-- costos, comandas) se recrean en Fase 2C.
--
-- Segundo hallazgo no buscado, más grave: process_sale tiene DOS
-- overloads vivos ahora mismo (11 y 15 parámetros). La de 15 es la
-- versión INSEGURA de 20260822010000_process_sale_configurable_benefit_credit.sql
-- (confía en p_benefit_enabled/p_benefit_daily_amount/p_weekly_credit_enabled/
-- p_weekly_credit_limit que manda el cliente -- exactamente el fraude
-- financiero que 20260822090000_process_sale_server_side_benefit_settings.sql
-- pensó que había cerrado). Esa migración creó una función NUEVA de 11
-- parámetros (lee los límites de `settings` ella misma) pero nunca
-- DROPeó la de 15 -- ambas firmas aceptan defaults para sus últimos
-- parámetros, así que ambas siguen siendo llamables. db.js/wing-house-web
-- solo mandan 11 nombres, y Postgres resuelve al candidato con MENOS
-- defaults (la de 11) cuando hay ambigüedad -- así que la app real usa la
-- versión segura. Pero cualquiera con la anon key puede llamar la de 15
-- directo por REST mandando los 4 parámetros extra a mano y saltarse los
-- topes de beneficio/crédito configurados en Ajustes por completo. Se
-- dropea aquí.

-- ==========================================================================
-- 1. process_sale: dropea el overload de 15 parámetros (inseguro, nunca
--    llamado por ninguna de las dos apps), deja solo el de 11 (lee límites
--    de `settings`), le agrega el guard de sesión.
-- ==========================================================================
DROP FUNCTION IF EXISTS public.process_sale(bigint, text, jsonb, text, numeric, numeric, text, bigint, text, text, boolean, boolean, numeric, boolean, numeric);

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

    -- Config de beneficio/crédito: ya NO viene del llamador, se lee aquí
    -- mismo de settings por sucursal (ver comentario de cabecera).
    v_benefit_enabled boolean;
    v_benefit_daily_amount numeric;
    v_weekly_credit_enabled boolean;
    v_weekly_credit_limit numeric;
    v_setting_value text;

BEGIN

    -- Fase 2B: branch_id ya no se confía, se valida contra la sesión.
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

-- ==========================================================================
-- 2. close_table
-- ==========================================================================
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
    IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
        RAISE EXCEPTION 'branch mismatch';
    END IF;

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
    LOOP
        UPDATE public.products
        SET stock = GREATEST(stock - v_item.quantity, 0)
        WHERE id = v_item.ref_id AND stock IS NOT NULL;
    END LOOP;

    v_folio := public.wh_next_folio(p_branch_id);

    UPDATE public.sales
    SET status = 'completada',
        folio = v_folio,
        discount = v_discount,
        total = v_total,
        payment_method = p_payment_method,
        amount_received = p_amount_received,
        opened_by = COALESCE(p_opened_by, opened_by),
        table_number = NULL
    WHERE id = p_sale_id AND branch_id = p_branch_id;

    RETURN json_build_object('id', p_sale_id, 'folio', v_folio, 'total', v_total);
END;
$function$;

-- ==========================================================================
-- 3. Lecturas críticas -- LANGUAGE sql no soporta IF/RAISE, se convierten a
--    plpgsql solo para poder guardar. Mismo resultado que antes cuando el
--    branch_id es válido.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.get_sale_items_summary(p_branch_id bigint, p_from timestamptz, p_to timestamptz)
 RETURNS TABLE(ref_id integer, item_type character varying, name character varying, quantity integer, subtotal numeric)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (p_branch_id = ANY (public.current_visible_branch_ids())) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  RETURN QUERY
  SELECT si.ref_id, si.item_type, si.name, si.quantity, si.subtotal
  FROM public.sale_items si
  JOIN public.sales s ON s.id = si.sale_id
  WHERE s.branch_id = p_branch_id
    AND s.status = 'completada'
    AND s.created_at >= p_from
    AND s.created_at <= p_to;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_sale_items_with_modifiers(p_branch_id bigint, p_sale_ids bigint[])
 RETURNS SETOF json
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (p_branch_id = ANY (public.current_visible_branch_ids())) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  RETURN QUERY
  SELECT to_jsonb(si) || jsonb_build_object(
    'sale_item_modifiers',
    COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('id', sim.id, 'modifier_id', sim.modifier_id) ORDER BY sim.id)
         FROM public.sale_item_modifiers sim
        WHERE sim.sale_item_id = si.id),
      '[]'::jsonb
    )
  )
  FROM public.sale_items si
  WHERE si.sale_id = ANY(p_sale_ids)
    AND si.branch_id = p_branch_id
  ORDER BY si.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_all_recipe_costs(p_branch_id bigint)
 RETURNS TABLE(product_id bigint, cost numeric)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (p_branch_id = ANY (public.current_visible_branch_ids())) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  RETURN QUERY
  SELECT r.product_id, SUM(r.quantity_needed * COALESCE(i.cost_per_unit, 0))
  FROM public.recipes r
  JOIN public.inventory i ON i.id = r.insumo_id
  WHERE r.branch_id = p_branch_id
  GROUP BY r.product_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_recipe_cost(p_branch_id bigint, p_product_id bigint)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cost numeric;
BEGIN
  IF NOT (p_branch_id = ANY (public.current_visible_branch_ids())) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  SELECT SUM(r.quantity_needed * COALESCE(i.cost_per_unit, 0))
    INTO v_cost
    FROM public.recipes r
    JOIN public.inventory i ON i.id = r.insumo_id
   WHERE r.branch_id = p_branch_id AND r.product_id = p_product_id;

  RETURN v_cost;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_roles_by_branch(p_branch_id bigint)
 RETURNS SETOF roles
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (p_branch_id = ANY (public.current_visible_branch_ids())) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  RETURN QUERY
  SELECT * FROM public.roles WHERE branch_id = p_branch_id ORDER BY is_system DESC, name;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_role_permissions(p_branch_id bigint, p_role_id bigint)
 RETURNS SETOF role_permissions
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (p_branch_id = ANY (public.current_visible_branch_ids())) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  RETURN QUERY
  SELECT rp.* FROM public.role_permissions rp
  JOIN public.roles r ON r.id = rp.role_id
  WHERE r.id = p_role_id AND r.branch_id = p_branch_id;
END;
$function$;

-- get_user_permissions no recibe p_branch_id -- el guard valida que el
-- USUARIO consultado (p_user_id) pertenezca a una sucursal visible para
-- quien llama, en vez de comparar branch_id directo.
CREATE OR REPLACE FUNCTION public.get_user_permissions(p_user_id bigint)
 RETURNS TABLE(module text, can_view boolean, can_create boolean, can_edit boolean, can_delete boolean)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = p_user_id AND u.branch_id = ANY (public.current_visible_branch_ids())
  ) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  RETURN QUERY
  SELECT rp.module, rp.can_view, rp.can_create, rp.can_edit, rp.can_delete
  FROM public.users u
  JOIN public.role_permissions rp ON rp.role_id = u.role_id
  WHERE u.id = p_user_id;
END;
$function$;

-- ==========================================================================
-- 4. liquidate_driver_sales: tampoco recibe p_branch_id (el driver_id uuid
--    ya identifica al repartidor). Antes liquidaba TODAS las ventas de ese
--    driver_id sin filtrar por sucursal -- se acota a current_branch_id()
--    directo, sin necesidad de agregar un parámetro nuevo.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.liquidate_driver_sales(p_driver_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count int;
  v_total numeric;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(total - delivery_fee), 0)
  INTO v_count, v_total
  FROM public.sales
  WHERE driver_id = p_driver_id
    AND payment_status = 'dinero_con_repartidor'
    AND branch_id = public.current_branch_id();

  UPDATE public.sales
  SET payment_status = 'liquidado',
      paid_at = now()
  WHERE driver_id = p_driver_id
    AND payment_status = 'dinero_con_repartidor'
    AND branch_id = public.current_branch_id();

  RETURN json_build_object('count', v_count, 'total', v_total);
END;
$function$;

-- ==========================================================================
-- 5. Roles y permisos
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.create_role(p_branch_id bigint, p_name text, p_description text)
 RETURNS roles
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row public.roles;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'El nombre del rol es obligatorio.';
  END IF;
  INSERT INTO public.roles (branch_id, name, description, is_system)
  VALUES (p_branch_id, btrim(p_name), p_description, false)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_role(p_branch_id bigint, p_id bigint, p_name text, p_description text)
 RETURNS roles
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row public.roles;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF EXISTS (SELECT 1 FROM public.roles WHERE id = p_id AND branch_id = p_branch_id AND is_system) THEN
    RAISE EXCEPTION 'El rol Admin no se puede renombrar.';
  END IF;
  UPDATE public.roles
  SET name = COALESCE(NULLIF(btrim(p_name), ''), name),
      description = p_description
  WHERE id = p_id AND branch_id = p_branch_id
  RETURNING * INTO v_row;
  IF v_row IS NULL THEN RAISE EXCEPTION 'No se encontró el rol % en esta sucursal', p_id; END IF;
  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.remove_role(p_branch_id bigint, p_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_system boolean;
  v_users_count integer;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  SELECT is_system INTO v_is_system FROM public.roles WHERE id = p_id AND branch_id = p_branch_id;
  IF v_is_system IS NULL THEN
    RAISE EXCEPTION 'No se encontró el rol % en esta sucursal', p_id;
  END IF;
  IF v_is_system THEN
    RAISE EXCEPTION 'El rol Admin no se puede eliminar.';
  END IF;

  SELECT COUNT(*) INTO v_users_count FROM public.users WHERE role_id = p_id;
  IF v_users_count > 0 THEN
    RAISE EXCEPTION 'Este rol todavía tiene % cuenta(s) asignada(s); reasígnalas antes de eliminarlo.', v_users_count;
  END IF;

  DELETE FROM public.roles WHERE id = p_id AND branch_id = p_branch_id;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_role_permissions(p_branch_id bigint, p_role_id bigint, p_permissions jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row jsonb;
  v_count integer := 0;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.roles WHERE id = p_role_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró el rol % en esta sucursal', p_role_id;
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_permissions, '[]'::jsonb))
  LOOP
    IF (v_row->>'module') IS NULL THEN CONTINUE; END IF;

    INSERT INTO public.role_permissions (role_id, module, can_view, can_create, can_edit, can_delete)
    VALUES (
      p_role_id,
      v_row->>'module',
      COALESCE((v_row->>'can_view')::boolean, false),
      COALESCE((v_row->>'can_create')::boolean, false),
      COALESCE((v_row->>'can_edit')::boolean, false),
      COALESCE((v_row->>'can_delete')::boolean, false)
    )
    ON CONFLICT (role_id, module) DO UPDATE SET
      can_view = EXCLUDED.can_view,
      can_create = EXCLUDED.can_create,
      can_edit = EXCLUDED.can_edit,
      can_delete = EXCLUDED.can_delete;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

-- ==========================================================================
-- 6. Settings / nómina
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.set_branch_setting(p_branch_id bigint, p_key text, p_value text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  INSERT INTO public.settings (key, value, branch_id)
  VALUES (p_key, p_value, p_branch_id)
  ON CONFLICT (key, branch_id) DO UPDATE SET value = EXCLUDED.value;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_payroll_deduction(
  p_branch_id bigint,
  p_employee_name text,
  p_amount numeric,
  p_sale_id bigint,
  p_reason text,
  p_status text,
  p_week_start date,
  p_week_end date
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  INSERT INTO public.payroll_deductions (
    branch_id, employee_name, amount, sale_id, reason, status, week_start, week_end
  ) VALUES (
    p_branch_id, p_employee_name, p_amount, p_sale_id, p_reason, p_status, p_week_start, p_week_end
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.upsert_payroll_history(p_branch_id bigint, p_rows jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row jsonb;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    INSERT INTO public.payroll_history (
      branch_id, week_start, week_end, employee_id, employee_name,
      sueldo_base, creditos, faltas, deduccion_faltas, beneficio_usado,
      total_pagado, cerrado_por
    ) VALUES (
      p_branch_id,
      (v_row->>'week_start')::date,
      (v_row->>'week_end')::date,
      (v_row->>'employee_id')::bigint,
      v_row->>'employee_name',
      COALESCE((v_row->>'sueldo_base')::numeric, 0),
      COALESCE((v_row->>'creditos')::numeric, 0),
      COALESCE((v_row->>'faltas')::int, 0),
      COALESCE((v_row->>'deduccion_faltas')::numeric, 0),
      COALESCE((v_row->>'beneficio_usado')::numeric, 0),
      COALESCE((v_row->>'total_pagado')::numeric, 0),
      v_row->>'cerrado_por'
    )
    ON CONFLICT (week_start, employee_id) DO UPDATE SET
      branch_id = EXCLUDED.branch_id,
      week_end = EXCLUDED.week_end,
      employee_name = EXCLUDED.employee_name,
      sueldo_base = EXCLUDED.sueldo_base,
      creditos = EXCLUDED.creditos,
      faltas = EXCLUDED.faltas,
      deduccion_faltas = EXCLUDED.deduccion_faltas,
      beneficio_usado = EXCLUDED.beneficio_usado,
      total_pagado = EXCLUDED.total_pagado,
      cerrado_por = EXCLUDED.cerrado_por,
      cerrado_at = now();
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.close_payroll_deductions(p_branch_id bigint, p_from timestamptz, p_to timestamptz)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  UPDATE public.payroll_deductions
     SET status = 'descontado'
   WHERE status = 'pendiente'
     AND branch_id = p_branch_id
     AND created_at >= p_from
     AND created_at <= p_to;
END;
$function$;

-- ==========================================================================
-- 7. update_sale_payment_status
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.update_sale_payment_status(p_branch_id bigint, p_sale_id bigint, p_status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF p_status NOT IN ('pendiente', 'pagado_en_caja', 'dinero_con_repartidor', 'liquidado') THEN
    RAISE EXCEPTION 'Estado de pago inválido: %', p_status;
  END IF;

  UPDATE public.sales
  SET payment_status = p_status
  WHERE id = p_sale_id
    AND branch_id = p_branch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró la venta % en esta sucursal', p_sale_id;
  END IF;
  RETURN true;
END;
$$;

-- ==========================================================================
-- 8. Recreación de las funciones CRÍTICAS que no existían en vivo (ver
--    hallazgo de cabecera) -- misma lógica que su migración original
--    (20260820020000/20260820040000/20260820050000), guard nuevo incluido
--    desde el origen.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.update_employee(
  p_branch_id bigint, p_id bigint, p_name text, p_role text,
  p_salary numeric, p_weekly_bonus numeric, p_active boolean
) RETURNS public.employees
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.employees;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  UPDATE public.employees
  SET name = p_name, role = COALESCE(p_role, 'Personal'),
      salary = COALESCE(p_salary, 0), weekly_bonus = COALESCE(p_weekly_bonus, 0),
      active = COALESCE(p_active, true)
  WHERE id = p_id AND branch_id = p_branch_id
  RETURNING * INTO v_row;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'No se encontró el empleado % en esta sucursal', p_id;
  END IF;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_employee(p_branch_id bigint, p_id bigint)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_in_use bigint;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.employees WHERE id = p_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró el empleado % en esta sucursal', p_id;
  END IF;

  SELECT count(*) INTO v_in_use FROM public.attendance WHERE employee_id = p_id;

  IF v_in_use > 0 THEN
    UPDATE public.employees SET active = false WHERE id = p_id AND branch_id = p_branch_id;
    RETURN json_build_object('deleted', false, 'deactivated', true);
  END IF;

  DELETE FROM public.employees WHERE id = p_id AND branch_id = p_branch_id;
  RETURN json_build_object('deleted', true, 'deactivated', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.save_fingerprint(p_branch_id bigint, p_employee_id bigint, p_template text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  UPDATE public.employees
  SET fingerprint_template = p_template, fingerprint_enrolled = true
  WHERE id = p_employee_id AND branch_id = p_branch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró el empleado % en esta sucursal', p_employee_id;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_fingerprint(p_branch_id bigint, p_employee_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  UPDATE public.employees
  SET fingerprint_template = NULL, fingerprint_enrolled = false
  WHERE id = p_employee_id AND branch_id = p_branch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró el empleado % en esta sucursal', p_employee_id;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_cash_cut_fondo_inicial(p_branch_id bigint, p_fecha date, p_fondo_inicial numeric)
RETURNS public.cash_cuts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.cash_cuts;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  INSERT INTO public.cash_cuts (fecha, branch_id, fondo_inicial)
  VALUES (p_fecha, p_branch_id, COALESCE(p_fondo_inicial, 0))
  ON CONFLICT (fecha, branch_id) DO UPDATE SET fondo_inicial = EXCLUDED.fondo_inicial
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.close_cash_cut(p_branch_id bigint, p_fecha date, p_fondo_inicial numeric, p_efectivo_real numeric, p_cerrado_por text)
RETURNS public.cash_cuts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_id bigint;
  v_row public.cash_cuts;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  SELECT id INTO v_existing_id FROM public.cash_cuts WHERE fecha = p_fecha AND branch_id = p_branch_id;

  IF v_existing_id IS NOT NULL THEN
    UPDATE public.cash_cuts
    SET fondo_inicial = p_fondo_inicial, efectivo_real = p_efectivo_real,
        cerrado_por = COALESCE(p_cerrado_por, 'admin'), cerrado_at = now()
    WHERE id = v_existing_id
    RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.cash_cuts (fecha, branch_id, fondo_inicial, efectivo_real, cerrado_por, cerrado_at)
    VALUES (p_fecha, p_branch_id, p_fondo_inicial, p_efectivo_real, COALESCE(p_cerrado_por, 'admin'), now())
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_cash_movement(
  p_branch_id bigint,
  p_fecha date,
  p_concepto text,
  p_monto numeric,
  p_metodo_pago text,
  p_categoria_costo text
) RETURNS public.cash_movements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.cash_movements;
  v_cost_category text;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF p_concepto IS NULL OR btrim(p_concepto) = '' THEN
    RAISE EXCEPTION 'El concepto de la salida es obligatorio.';
  END IF;

  INSERT INTO public.cash_movements (fecha, concepto, monto, metodo_pago, categoria_costo, branch_id)
  VALUES (COALESCE(p_fecha, (now() AT TIME ZONE 'America/Mexico_City')::date), btrim(p_concepto), COALESCE(p_monto, 0),
          COALESCE(p_metodo_pago, 'efectivo'), COALESCE(p_categoria_costo, 'otros'), p_branch_id)
  RETURNING * INTO v_row;

  v_cost_category := CASE p_categoria_costo
    WHEN 'repartidores' THEN 'variable'
    WHEN 'basura' THEN 'variable'
    WHEN 'insumos' THEN 'insumo'
    WHEN 'otros' THEN 'variable'
    ELSE 'variable'
  END;

  BEGIN
    INSERT INTO public.costs (concept, category, amount, date, metodo_pago, branch_id)
    VALUES (v_row.concepto, v_cost_category, v_row.monto, v_row.fecha, v_row.metodo_pago, p_branch_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'No se pudo espejar la salida en costs: %', SQLERRM;
  END;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_cash_movement(p_branch_id bigint, p_id bigint)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  DELETE FROM public.cash_movements WHERE id = p_id AND branch_id = p_branch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró la salida de caja % en esta sucursal', p_id;
  END IF;
  RETURN json_build_object('deleted', true);
END;
$$;

-- ==========================================================================
-- 9. Permisos: anon fuera, solo authenticated. GRANT explícito en las 9
--    recreadas (nunca tuvieron GRANT en esta sesión); REVOKE explícito en
--    las que sí tenían anon antes.
-- ==========================================================================
REVOKE EXECUTE ON FUNCTION public.process_sale(bigint, text, jsonb, text, numeric, numeric, text, bigint, text, text, boolean) FROM anon;
REVOKE EXECUTE ON FUNCTION public.close_table(bigint, bigint, numeric, text, numeric, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_sale_items_summary(bigint, timestamptz, timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_sale_items_with_modifiers(bigint, bigint[]) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_all_recipe_costs(bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_recipe_cost(bigint, bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_roles_by_branch(bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_role_permissions(bigint, bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_user_permissions(bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.liquidate_driver_sales(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_role(bigint, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_role(bigint, bigint, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.remove_role(bigint, bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_role_permissions(bigint, bigint, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_branch_setting(bigint, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_payroll_deduction(bigint, text, numeric, bigint, text, text, date, date) FROM anon;
REVOKE EXECUTE ON FUNCTION public.upsert_payroll_history(bigint, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.close_payroll_deductions(bigint, timestamptz, timestamptz) FROM anon;

GRANT EXECUTE ON FUNCTION public.process_sale(bigint, text, jsonb, text, numeric, numeric, text, bigint, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_table(bigint, bigint, numeric, text, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sale_items_summary(bigint, timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sale_items_with_modifiers(bigint, bigint[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_all_recipe_costs(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_recipe_cost(bigint, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_roles_by_branch(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_role_permissions(bigint, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_permissions(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.liquidate_driver_sales(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_role(bigint, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_role(bigint, bigint, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_role(bigint, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_role_permissions(bigint, bigint, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_branch_setting(bigint, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_payroll_deduction(bigint, text, numeric, bigint, text, text, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_payroll_history(bigint, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_payroll_deductions(bigint, timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_sale_payment_status(bigint, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_employee(bigint, bigint, text, text, numeric, numeric, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_employee(bigint, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_fingerprint(bigint, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_fingerprint(bigint, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_cash_cut_fondo_inicial(bigint, date, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_cash_cut(bigint, date, numeric, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_cash_movement(bigint, date, text, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_cash_movement(bigint, bigint) TO authenticated;

-- ==========================================================================
-- 10. Limpieza de las funciones temporales de introspección de esta sesión
--     (mismo patrón que 20260815080000_cleanup_verification_and_tmp_funcs.sql).
-- ==========================================================================
DROP FUNCTION IF EXISTS public.tmp_introspect_anon_rpcs();
DROP FUNCTION IF EXISTS public.tmp_introspect_overload_counts();
DROP FUNCTION IF EXISTS public.tmp_introspect_missing_names();
DROP FUNCTION IF EXISTS public.tmp_introspect_exact_names();
DROP FUNCTION IF EXISTS public.tmp_introspect_total_count();
DROP FUNCTION IF EXISTS public.tmp_introspect_all_names();
