-- Opción A -- Tarea 2 / Migración 0009 (parte 1 de 2): funciones de las que
-- SÍ tenemos el cuerpo completo versionado en este repo (17 en total,
-- releídas contra la migración más reciente que las tocó -- no la primera
-- que aparecía en el historial, ver notas en cada bloque), más los
-- wrappers nuevos que reemplazan escrituras directas a sales/sale_items
-- sobre las que la migración anterior (20260820010000) ya negó
-- INSERT/UPDATE/DELETE para anon.
--
-- Los RPC que SÍ siguen sin versionar en este repo (viven solo en el
-- dashboard de Supabase) son: cancel_table, comanda_board,
-- comanda_update_kitchen, register_attendance, create_employee,
-- get_employee_daily_consumption, get_payroll_week_credit,
-- set_payroll_bonus, wh_next_folio. Reescribirlos aquí a ciegas arriesgaría
-- cambiar lógica de negocio, que la Tarea 3 pide explícitamente NO tocar.
-- Ver 20260820060000_tmp_introspect_pending_rpcs.sql: corre esa consulta en
-- el SQL Editor de Supabase y pégame el resultado para generar la parte 2
-- sin adivinar.
--
-- Regla aplicada en todas las funciones de este archivo: p_branch_id
-- bigint es el primer parámetro obligatorio (sin DEFAULT) -- si no se
-- manda, PostgREST rechaza la llamada porque no matchea ninguna
-- sobrecarga.

-- CREATE OR REPLACE FUNCTION solo reemplaza in-place cuando el tipo de los
-- parámetros no cambia. p_branch_id es un parámetro nuevo al inicio de la
-- firma de las 4 funciones de abajo, así que sin este DROP explícito
-- Postgres crearía una SEGUNDA sobrecarga y dejaría la versión vieja (sin
-- validar sucursal) seguir viva y llamable -- justo el bug que se está
-- cerrando.
-- OJO: el process_sale vigente hoy en Supabase es el de
-- 20260819090300_fix_web_takeout_stays_open.sql (10 parámetros, con
-- p_is_delivery), NO el de 20260815070100 (9 parámetros) -- ese quedó
-- reemplazado desde 20260816010000. Se dropean ambas firmas posibles por si
-- alguna instalación se quedó atrás en alguna migración intermedia.
DROP FUNCTION IF EXISTS public.process_sale(text, jsonb, text, numeric, numeric, text, bigint, text, text);
DROP FUNCTION IF EXISTS public.process_sale(text, jsonb, text, numeric, numeric, text, bigint, text, text, boolean);
DROP FUNCTION IF EXISTS public.comanda_update_item_qty(bigint, integer);
DROP FUNCTION IF EXISTS public.comanda_remove_item(bigint);
DROP FUNCTION IF EXISTS public.comanda_set_delivery(bigint, text, text, text, numeric, text);

-- ============================================================
-- 1. process_sale -- agrega p_branch_id, valida sucursal, valida que el
--    empleado (si aplica) pertenezca a esa sucursal (employees ya tiene
--    branch_id desde 20260820000000), y guarda branch_id en la venta. El
--    resto (incluido p_is_delivery / v_status y el fix de
--    20260819090300_fix_web_takeout_stays_open.sql para que "Llevar" desde
--    la web nazca 'abierta') es idéntico a la versión vigente.
-- ============================================================
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
  p_is_delivery boolean DEFAULT false
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
    v_benefit_available numeric := 100;

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
          AND consumption_date = v_today;

        v_benefit_available :=
            ROUND(
                GREATEST(
                    100 - v_today_consumed,
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
                credit_week_start
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
                END
            );

        END IF;

    END LOOP;

    IF p_client_type = 'employee'
       AND (
           v_credit_amount > 0
           OR v_benefit_amount > 0
       )
    THEN

        v_week_start :=
            date_trunc(
                'week',
                v_today
            )::date;

        INSERT INTO public.employee_weekly_credit (
            employee_id,
            employee_name,
            week_start,
            benefit_used,
            credit_amount,
            paid_amount,
            payroll_deducted
        )
        VALUES (
            p_employee_id,
            v_employee_name,
            v_week_start,
            v_benefit_amount,
            v_credit_amount,
            v_employee_paid,
            false
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

GRANT EXECUTE ON FUNCTION public.process_sale(bigint, text, jsonb, text, numeric, numeric, text, bigint, text, text, boolean) TO anon, authenticated;

-- ============================================================
-- 2. comanda_update_item_qty -- agrega p_branch_id y lo valida contra la
--    sucursal real de la venta dueña del renglón (el IDOR confirmado en la
--    auditoría, A3).
-- ============================================================
CREATE OR REPLACE FUNCTION public.comanda_update_item_qty(p_branch_id bigint, p_item_id bigint, p_quantity integer)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_sale_id bigint;
    v_sale json;
BEGIN

    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        RAISE EXCEPTION 'La cantidad debe ser mayor que cero.';
    END IF;

    SELECT si.sale_id
    INTO v_sale_id
    FROM public.sale_items si
    JOIN public.sales s ON s.id = si.sale_id
    WHERE si.id = p_item_id
      AND s.branch_id = p_branch_id
    LIMIT 1;

    IF v_sale_id IS NULL THEN
        RAISE EXCEPTION 'No se encontró el artículo de la comanda en esta sucursal.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.sales
        WHERE id = v_sale_id
          AND status = 'abierta'
    ) THEN
        RAISE EXCEPTION 'La mesa ya no está abierta.';
    END IF;

    UPDATE public.sale_items
    SET
        quantity = p_quantity,
        subtotal = COALESCE(unit_price, 0) * p_quantity
    WHERE id = p_item_id;

    UPDATE public.sales
    SET total = COALESCE(
        (
            SELECT SUM(si.subtotal)
            FROM public.sale_items si
            WHERE si.sale_id = v_sale_id
        ),
        0
    )
    WHERE id = v_sale_id
      AND status = 'abierta';

    SELECT row_to_json(s)
    INTO v_sale
    FROM public.sales s
    WHERE s.id = v_sale_id
    LIMIT 1;

    IF v_sale IS NULL THEN
        RAISE EXCEPTION 'No se pudo recuperar la mesa actualizada.';
    END IF;

    RETURN v_sale;

END;
$function$;

GRANT EXECUTE ON FUNCTION public.comanda_update_item_qty(bigint, bigint, integer) TO anon;

-- ============================================================
-- 3. comanda_remove_item -- mismo fix que comanda_update_item_qty.
-- ============================================================
CREATE OR REPLACE FUNCTION public.comanda_remove_item(p_branch_id bigint, p_item_id bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_sale_id bigint;
    v_sale json;
BEGIN

    SELECT si.sale_id
    INTO v_sale_id
    FROM public.sale_items si
    JOIN public.sales s ON s.id = si.sale_id
    WHERE si.id = p_item_id
      AND s.branch_id = p_branch_id
    LIMIT 1;

    IF v_sale_id IS NULL THEN
        RAISE EXCEPTION 'No se encontró el artículo de la comanda en esta sucursal.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.sales
        WHERE id = v_sale_id
          AND status = 'abierta'
    ) THEN
        RAISE EXCEPTION 'La mesa ya no está abierta.';
    END IF;

    DELETE FROM public.sale_items
    WHERE id = p_item_id;

    UPDATE public.sales
    SET total = COALESCE(
        (
            SELECT SUM(si.subtotal)
            FROM public.sale_items si
            WHERE si.sale_id = v_sale_id
        ),
        0
    )
    WHERE id = v_sale_id
      AND status = 'abierta';

    SELECT row_to_json(s)
    INTO v_sale
    FROM public.sales s
    WHERE s.id = v_sale_id
    LIMIT 1;

    IF v_sale IS NULL THEN
        RAISE EXCEPTION 'No se pudo recuperar la mesa después de eliminar el artículo.';
    END IF;

    RETURN v_sale;

END;
$function$;

GRANT EXECUTE ON FUNCTION public.comanda_remove_item(bigint, bigint) TO anon;

-- ============================================================
-- 4. comanda_set_delivery -- agrega p_branch_id al WHERE del UPDATE. OJO: la
--    versión real vigente NO es la de 0004_delivery_orders.sql (esa quedó
--    reemplazada) sino la de 20260819050000_delivery_payment_flow.sql, que
--    además arranca payment_status = 'pendiente' -- se preserva ese campo,
--    que la primera pasada de esta migración había perdido por trabajar
--    sobre la fuente vieja.
-- ============================================================
CREATE OR REPLACE FUNCTION public.comanda_set_delivery(
  p_branch_id bigint,
  p_sale_id bigint,
  p_customer_name text,
  p_customer_phone text,
  p_delivery_address text,
  p_delivery_fee numeric,
  p_driver_name text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.sales
  SET is_delivery = true,
      customer_name = p_customer_name,
      customer_phone = p_customer_phone,
      delivery_address = p_delivery_address,
      delivery_fee = coalesce(p_delivery_fee, 0),
      driver_name = p_driver_name,
      delivery_status = 'pendiente',
      payment_status = 'pendiente',
      total = total + coalesce(p_delivery_fee, 0)
  WHERE id = p_sale_id
    AND branch_id = p_branch_id
    AND client_type = 'Llevar';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró una venta "Llevar" con id % en esta sucursal', p_sale_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.comanda_set_delivery(bigint, bigint, text, text, text, numeric, text) TO anon, authenticated;

-- Overloads muertos de comanda_set_delivery (creados a mano fuera de
-- cualquier migración, ver 20260819070000_fix_comanda_set_delivery_ambiguous_overload.sql
-- / wing-house-web/supabase/migrations/0005): defensivo, por si alguna
-- instalación todavía los tiene.
DROP FUNCTION IF EXISTS public.comanda_set_delivery(text, text, text, numeric, text, bigint, boolean);
DROP FUNCTION IF EXISTS public.comanda_set_delivery(bigint);

-- ============================================================
-- 5. mark_sale_printed -- reemplaza el UPDATE directo de
--    db.js:markSalePrinted (sales.update({printed:true}).eq('id', id)).
-- ============================================================
CREATE OR REPLACE FUNCTION public.mark_sale_printed(p_branch_id bigint, p_sale_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.sales
  SET printed = true
  WHERE id = p_sale_id
    AND branch_id = p_branch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró la venta % en esta sucursal', p_sale_id;
  END IF;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_sale_printed(bigint, bigint) TO anon;

-- ============================================================
-- 6. comanda_update_delivery_status -- reemplaza el UPDATE directo de
--    db.js:comandaSetDeliveryStatus, MISMA lógica (incluido el efecto
--    secundario de cerrar la venta y fijar payment_status al llegar a
--    'entregado').
-- ============================================================
CREATE OR REPLACE FUNCTION public.comanda_update_delivery_status(p_branch_id bigint, p_sale_id bigint, p_status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('en_camino', 'entregado') THEN
    RAISE EXCEPTION 'Estado de entrega inválido: %', p_status;
  END IF;

  UPDATE public.sales
  SET delivery_status = p_status,
      status = CASE WHEN p_status = 'entregado' THEN 'completada' ELSE status END,
      payment_status = CASE WHEN p_status = 'entregado' THEN 'dinero_con_repartidor' ELSE payment_status END
  WHERE id = p_sale_id
    AND branch_id = p_branch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró la venta % en esta sucursal', p_sale_id;
  END IF;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.comanda_update_delivery_status(bigint, bigint, text) TO anon;

-- ============================================================
-- 7. update_sale_payment_status -- reemplaza el UPDATE directo de
--    db.js:updateSalePaymentStatus, misma lista VALID.
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_sale_payment_status(p_branch_id bigint, p_sale_id bigint, p_status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
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

GRANT EXECUTE ON FUNCTION public.update_sale_payment_status(bigint, bigint, text) TO anon;

-- ============================================================
-- 8. update_kds_status -- reemplaza el UPDATE directo de
--    db.js:updateKdsStatus, incluida la columna de timestamp por estado y
--    el efecto secundario 'Llevar'+entregada -> completada.
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_kds_status(p_branch_id bigint, p_sale_id bigint, p_status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_client_type text;
BEGIN
  IF p_status NOT IN ('nueva', 'en_preparacion', 'lista', 'entregada') THEN
    RAISE EXCEPTION 'Estado de KDS inválido: %', p_status;
  END IF;

  IF p_status = 'entregada' THEN
    SELECT client_type INTO v_client_type
    FROM public.sales
    WHERE id = p_sale_id AND branch_id = p_branch_id;
  END IF;

  UPDATE public.sales
  SET kds_status = p_status,
      kds_started_at = CASE WHEN p_status = 'en_preparacion' THEN now() ELSE kds_started_at END,
      kds_ready_at = CASE WHEN p_status = 'lista' THEN now() ELSE kds_ready_at END,
      kds_delivered_at = CASE WHEN p_status = 'entregada' THEN now() ELSE kds_delivered_at END,
      status = CASE WHEN p_status = 'entregada' AND v_client_type = 'Llevar' THEN 'completada' ELSE status END
  WHERE id = p_sale_id
    AND branch_id = p_branch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró la orden % en esta sucursal', p_sale_id;
  END IF;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_kds_status(bigint, bigint, text) TO anon;

-- ============================================================
-- 9. comanda_add_item_with_modifiers -- reemplaza DOS sitios que hoy
--    insertan directo en sale_items + sale_item_modifiers sin RPC:
--    db.js:comandaAddItemWithModifiers (escritorio) y el bloque de
--    comandas.jsx:279-314 (web) que hace lo mismo a mano para renglones con
--    salsa o nota. Unifica ambos -- misma lógica que ya tenían los dos.
--    p_modifier_ids/p_notes son opcionales para poder reusarla también
--    donde antes se llamaba comanda_add_item sin modificador ni nota.
-- ============================================================
CREATE OR REPLACE FUNCTION public.comanda_add_item_with_modifiers(
  p_branch_id bigint,
  p_sale_id bigint,
  p_ref_id bigint,
  p_item_type text,
  p_name text,
  p_unit_price numeric,
  p_quantity numeric,
  p_modifier_ids bigint[] DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_item_id bigint;
  v_modifier_id bigint;
  v_total numeric;
  v_sale json;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.sales
    WHERE id = p_sale_id AND branch_id = p_branch_id AND status = 'abierta'
  ) THEN
    RAISE EXCEPTION 'La mesa % no está abierta en esta sucursal', p_sale_id;
  END IF;

  INSERT INTO public.sale_items (sale_id, ref_id, item_type, name, unit_price, quantity, subtotal, notes)
  VALUES (p_sale_id, p_ref_id, COALESCE(p_item_type, 'product'), p_name, p_unit_price, p_quantity, p_unit_price * p_quantity, p_notes)
  RETURNING id INTO v_new_item_id;

  IF p_modifier_ids IS NOT NULL THEN
    FOREACH v_modifier_id IN ARRAY p_modifier_ids LOOP
      INSERT INTO public.sale_item_modifiers (sale_item_id, modifier_id)
      VALUES (v_new_item_id, v_modifier_id);
    END LOOP;
  END IF;

  SELECT COALESCE(SUM(subtotal), 0) INTO v_total FROM public.sale_items WHERE sale_id = p_sale_id;
  UPDATE public.sales SET total = v_total WHERE id = p_sale_id;

  SELECT row_to_json(s) INTO v_sale FROM public.sales s WHERE s.id = p_sale_id;
  RETURN v_sale;
END;
$$;

GRANT EXECUTE ON FUNCTION public.comanda_add_item_with_modifiers(bigint, bigint, bigint, text, text, numeric, numeric, bigint[], text) TO anon;

-- ============================================================
-- 10. set_sale_cashier -- reemplaza DOS sitios que hacían
--     sales.update({cashier_user_id, branch_id}).eq('id', saleId) directo:
--     db.js:createSale (después de process_sale) y
--     db.js:comandaCloseTable (después de close_table). Ambos quedarían
--     bloqueados por 20260820010000 sin esto, aunque process_sale/close_table
--     en sí no cambien.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_sale_cashier(p_branch_id bigint, p_sale_id bigint, p_cashier_user_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.sales
  SET cashier_user_id = p_cashier_user_id
  WHERE id = p_sale_id
    AND branch_id = p_branch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró la venta % en esta sucursal', p_sale_id;
  END IF;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_sale_cashier(bigint, bigint, bigint) TO anon;

-- ============================================================
-- 11. set_sale_item_notes_and_modifiers -- reemplaza el bloque de
--     comandas.jsx (web, pedido "Llevar" con domicilio) que hoy actualiza
--     notes y agrega sale_item_modifiers DIRECTO sobre renglones que
--     process_sale ya insertó (a diferencia de
--     comanda_add_item_with_modifiers, este NO inserta un renglón nuevo --
--     opera sobre uno que ya existe).
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_sale_item_notes_and_modifiers(
  p_branch_id bigint,
  p_sale_item_id bigint,
  p_notes text,
  p_modifier_ids bigint[]
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_modifier_id bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.sale_items si
    JOIN public.sales s ON s.id = si.sale_id
    WHERE si.id = p_sale_item_id AND s.branch_id = p_branch_id
  ) THEN
    RAISE EXCEPTION 'No se encontró el renglón % en esta sucursal', p_sale_item_id;
  END IF;

  IF p_notes IS NOT NULL THEN
    UPDATE public.sale_items SET notes = p_notes WHERE id = p_sale_item_id;
  END IF;

  IF p_modifier_ids IS NOT NULL THEN
    FOREACH v_modifier_id IN ARRAY p_modifier_ids LOOP
      INSERT INTO public.sale_item_modifiers (sale_item_id, modifier_id)
      VALUES (p_sale_item_id, v_modifier_id);
    END LOOP;
  END IF;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_sale_item_notes_and_modifiers(bigint, bigint, text, bigint[]) TO anon;

-- ============================================================
-- 12-17. Encontradas de última hora en el propio repo (no eran "caja negra"
-- como se pensó al principio): comanda_open_table y comanda_add_item
-- "planas" + close_table están en
-- 20260815040100_fix_comanda_functions_missing_columns.sql;
-- comanda_open_takeout en 20260816000000_comanda_takeout_orders.sql;
-- comanda_assign_driver y liquidate_driver_sales en
-- 20260819050000_delivery_payment_flow.sql. Se reescriben aquí con
-- p_branch_id igual que el resto -- YA NO están pendientes de
-- introspección (se quitan de 20260820060000_tmp_introspect_pending_rpcs.sql).
-- ============================================================
DROP FUNCTION IF EXISTS public.comanda_open_table(integer, text);
DROP FUNCTION IF EXISTS public.comanda_add_item(bigint, integer, text, text, numeric, integer);
DROP FUNCTION IF EXISTS public.close_table(bigint, numeric, text, numeric, text);
DROP FUNCTION IF EXISTS public.comanda_open_takeout(text);
DROP FUNCTION IF EXISTS public.comanda_assign_driver(bigint, uuid, numeric);
DROP FUNCTION IF EXISTS public.liquidate_driver_sales(uuid);

-- 12. comanda_open_table
CREATE OR REPLACE FUNCTION public.comanda_open_table(p_branch_id bigint, p_table_number integer, p_opened_by text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_id bigint;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch_id) THEN
        RAISE EXCEPTION 'La sucursal % no existe.', p_branch_id;
    END IF;

    IF p_table_number IS NULL OR p_table_number <= 0 THEN
        RAISE EXCEPTION 'Número de mesa inválido.';
    END IF;

    -- Evita que dos clics simultáneos abran dos comandas para la misma mesa.
    -- Se combina branch_id en el lock para que dos sucursales con "Mesa 1"
    -- cada una no se bloqueen entre sí.
    PERFORM pg_advisory_xact_lock(p_branch_id, p_table_number::bigint);

    SELECT s.id
      INTO v_id
      FROM public.sales s
     WHERE s.status = 'abierta'
       AND s.table_number = p_table_number
       AND s.branch_id = p_branch_id
     ORDER BY s.id DESC
     LIMIT 1;

    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;

    INSERT INTO public.sales (
        branch_id,
        client_type,
        payment_method,
        total,
        status,
        table_number,
        opened_by,
        printed
    )
    VALUES (
        p_branch_id,
        'Mesa',
        'efectivo',
        0,
        'abierta',
        p_table_number,
        p_opened_by,
        false
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.comanda_open_table(bigint, integer, text) TO anon;

-- 13. comanda_add_item (renglón plano, sin modificadores/notas -- fusiona
--     cantidad con un renglón existente igual, a diferencia de
--     comanda_add_item_with_modifiers).
CREATE OR REPLACE FUNCTION public.comanda_add_item(p_branch_id bigint, p_sale_id bigint, p_ref_id integer, p_item_type text, p_name text, p_unit_price numeric, p_quantity integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_status character varying;
    v_existing_id bigint;
    v_existing_qty integer;
    v_stock numeric;
    v_new_qty integer;
BEGIN
    IF p_sale_id IS NULL OR p_sale_id <= 0 THEN
        RAISE EXCEPTION 'ID de comanda inválido.';
    END IF;

    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        RAISE EXCEPTION 'La cantidad debe ser mayor que cero.';
    END IF;

    IF p_name IS NULL OR btrim(p_name) = '' THEN
        RAISE EXCEPTION 'El nombre del artículo es obligatorio.';
    END IF;

    IF p_unit_price IS NULL OR p_unit_price < 0 THEN
        RAISE EXCEPTION 'El precio del artículo es inválido.';
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
        RAISE EXCEPTION 'La comanda ya no está abierta.';
    END IF;

    SELECT si.id, si.quantity
      INTO v_existing_id, v_existing_qty
      FROM public.sale_items si
     WHERE si.sale_id = p_sale_id
       AND si.item_type = COALESCE(p_item_type, 'product')
       AND (
            (p_ref_id IS NULL AND si.ref_id IS NULL)
            OR si.ref_id = p_ref_id
       )
     ORDER BY si.id
     LIMIT 1
     FOR UPDATE;

    v_new_qty := COALESCE(v_existing_qty, 0) + p_quantity;

    IF COALESCE(p_item_type, 'product') = 'product'
       AND p_ref_id IS NOT NULL
    THEN
        SELECT p.stock
          INTO v_stock
          FROM public.products p
         WHERE p.id = p_ref_id
           AND p.active = true
         FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'El producto no existe o está inactivo.';
        END IF;

        IF v_stock IS NOT NULL AND v_stock < v_new_qty THEN
            RAISE EXCEPTION '"%" no tiene existencia suficiente. Disponible: %, solicitado: %.',
                p_name, v_stock, v_new_qty;
        END IF;
    END IF;

    IF v_existing_id IS NOT NULL THEN
        UPDATE public.sale_items
           SET quantity = v_new_qty,
               subtotal = v_new_qty * unit_price
         WHERE id = v_existing_id;
    ELSE
        INSERT INTO public.sale_items (
            sale_id, ref_id, item_type, name, unit_price, quantity, subtotal
        )
        VALUES (
            p_sale_id, p_ref_id, COALESCE(p_item_type, 'product'), p_name, p_unit_price, p_quantity, p_unit_price * p_quantity
        );
    END IF;

    UPDATE public.sales s
       SET total = x.subtotal
      FROM (
          SELECT sale_id, COALESCE(SUM(subtotal), 0) AS subtotal
            FROM public.sale_items
           WHERE sale_id = p_sale_id
           GROUP BY sale_id
      ) x
     WHERE s.id = x.sale_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.comanda_add_item(bigint, bigint, integer, text, text, numeric, integer) TO anon;

-- 14. close_table
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

    IF p_amount_received IS NOT NULL AND p_amount_received < v_total THEN
        RAISE EXCEPTION 'El monto recibido ($%) es menor al total ($%).',
            p_amount_received, v_total;
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

    v_folio := public.wh_next_folio();

    UPDATE public.sales
       SET folio = v_folio,
           total = v_total,
           status = 'completada',
           payment_method = COALESCE(NULLIF(p_payment_method, ''), 'efectivo'),
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

-- 15. comanda_open_takeout
CREATE OR REPLACE FUNCTION public.comanda_open_takeout(p_branch_id bigint, p_opened_by text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_id bigint;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch_id) THEN
        RAISE EXCEPTION 'La sucursal % no existe.', p_branch_id;
    END IF;

    INSERT INTO public.sales (
        branch_id, client_type, payment_method, total, status, table_number, opened_by, printed
    )
    VALUES (
        p_branch_id, 'Para llevar', 'efectivo', 0, 'abierta', NULL, p_opened_by, false
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.comanda_open_takeout(bigint, text) TO anon;

-- 16. comanda_assign_driver -- ahora también valida que el repartidor sea
--     de esta sucursal (drivers ya tiene branch_id desde 20260820000000).
CREATE OR REPLACE FUNCTION public.comanda_assign_driver(p_branch_id bigint, p_sale_id bigint, p_driver_id uuid, p_delivery_fee numeric)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_driver_name text;
  v_old_fee numeric;
  v_delta numeric;
BEGIN
  SELECT name INTO v_driver_name
  FROM public.drivers
  WHERE id = p_driver_id AND active = true AND branch_id = p_branch_id;

  IF v_driver_name IS NULL THEN
    RAISE EXCEPTION 'El repartidor seleccionado no existe, está inactivo o no pertenece a esta sucursal.';
  END IF;

  SELECT delivery_fee INTO v_old_fee
  FROM public.sales
  WHERE id = p_sale_id AND branch_id = p_branch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró el pedido en esta sucursal.';
  END IF;

  v_delta := COALESCE(p_delivery_fee, 0) - COALESCE(v_old_fee, 0);

  UPDATE public.sales
  SET driver_id = p_driver_id,
      driver_name = v_driver_name,
      delivery_fee = COALESCE(p_delivery_fee, 0),
      total = total + v_delta,
      delivery_status = 'en_camino'
  WHERE id = p_sale_id
    AND branch_id = p_branch_id
    AND is_delivery = true
    AND driver_id IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El pedido ya tiene repartidor asignado o no es a domicilio.';
  END IF;

  RETURN json_build_object(
    'driver_id', p_driver_id,
    'driver_name', v_driver_name,
    'delivery_fee', COALESCE(p_delivery_fee, 0)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.comanda_assign_driver(bigint, bigint, uuid, numeric) TO anon, authenticated;

-- 17. liquidate_driver_sales
CREATE OR REPLACE FUNCTION public.liquidate_driver_sales(p_branch_id bigint, p_driver_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
  v_total numeric;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(total - delivery_fee), 0)
  INTO v_count, v_total
  FROM public.sales
  WHERE driver_id = p_driver_id
    AND branch_id = p_branch_id
    AND payment_status = 'dinero_con_repartidor';

  UPDATE public.sales
  SET payment_status = 'liquidado',
      paid_at = now()
  WHERE driver_id = p_driver_id
    AND branch_id = p_branch_id
    AND payment_status = 'dinero_con_repartidor';

  RETURN json_build_object('count', v_count, 'total', v_total);
END;
$$;

GRANT EXECUTE ON FUNCTION public.liquidate_driver_sales(bigint, uuid) TO anon, authenticated;
