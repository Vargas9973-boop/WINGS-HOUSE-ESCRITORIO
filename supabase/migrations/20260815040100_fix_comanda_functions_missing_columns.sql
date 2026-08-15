-- comanda_open_table, comanda_add_item y close_table todavía escriben en
-- sales.subtotal / sales.discount / sales.change_given, columnas que ya no
-- existen en la tabla real (solo queda sales.total). Esto rompe abrir mesa,
-- agregar artículos y cobrar una comanda con "column ... does not exist".
-- Se reescriben para usar únicamente sales.total, igual que ya hacen
-- comanda_update_item_qty y comanda_remove_item (que sí funcionan hoy).

CREATE OR REPLACE FUNCTION public.comanda_open_table(p_table_number integer, p_opened_by text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_id bigint;
BEGIN
    IF p_table_number IS NULL OR p_table_number <= 0 THEN
        RAISE EXCEPTION 'Número de mesa inválido.';
    END IF;

    -- Evita que dos clics simultáneos abran dos comandas para la misma mesa.
    PERFORM pg_advisory_xact_lock(p_table_number::bigint);

    SELECT s.id
      INTO v_id
      FROM public.sales s
     WHERE s.status = 'abierta'
       AND s.table_number = p_table_number
     ORDER BY s.id DESC
     LIMIT 1;

    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;

    INSERT INTO public.sales (
        client_type,
        payment_method,
        total,
        status,
        table_number,
        opened_by,
        printed
    )
    VALUES (
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

CREATE OR REPLACE FUNCTION public.comanda_add_item(p_sale_id bigint, p_ref_id integer, p_item_type text, p_name text, p_unit_price numeric, p_quantity integer)
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
     FOR UPDATE;

    IF v_status IS NULL THEN
        RAISE EXCEPTION 'La comanda no existe.';
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

    -- Las promociones no consumen existencia de products.
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
            sale_id,
            ref_id,
            item_type,
            name,
            unit_price,
            quantity,
            subtotal
        )
        VALUES (
            p_sale_id,
            p_ref_id,
            COALESCE(p_item_type, 'product'),
            p_name,
            p_unit_price,
            p_quantity,
            p_unit_price * p_quantity
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

CREATE OR REPLACE FUNCTION public.close_table(p_sale_id bigint, p_discount numeric, p_payment_method text, p_amount_received numeric, p_opened_by text)
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
     FOR UPDATE;

    IF v_status IS NULL THEN
        RAISE EXCEPTION 'La comanda no existe.';
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

    -- Descontar existencia una sola vez, al cerrar la comanda.
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
            -- Si stock es NULL, el producto no controla existencia.
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
