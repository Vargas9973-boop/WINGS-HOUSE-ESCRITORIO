-- comanda_update_item_qty y comanda_remove_item existían en la base de
-- datos remota pero nunca se habían versionado en una migración (fueron
-- editadas directamente desde el dashboard de Supabase en algún momento
-- para devolver la venta actualizada como json en vez de un id). Esta
-- migración solo documenta/fija la definición que ya está corriendo en
-- producción; no cambia su comportamiento.
CREATE OR REPLACE FUNCTION public.comanda_update_item_qty(p_item_id bigint, p_quantity integer)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_sale_id bigint;
    v_sale json;
BEGIN

    -- Validar cantidad
    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        RAISE EXCEPTION 'La cantidad debe ser mayor que cero.';
    END IF;

    -- Encontrar la venta del artículo
    SELECT sale_id
    INTO v_sale_id
    FROM public.sale_items
    WHERE id = p_item_id
    LIMIT 1;

    IF v_sale_id IS NULL THEN
        RAISE EXCEPTION 'No se encontró el artículo de la comanda.';
    END IF;

    -- Comprobar que la mesa esté abierta
    IF NOT EXISTS (
        SELECT 1
        FROM public.sales
        WHERE id = v_sale_id
          AND status = 'abierta'
    ) THEN
        RAISE EXCEPTION 'La mesa ya no está abierta.';
    END IF;

    -- Actualizar cantidad y subtotal
    UPDATE public.sale_items
    SET
        quantity = p_quantity,
        subtotal = COALESCE(unit_price, 0) * p_quantity
    WHERE id = p_item_id;

    -- Recalcular el total de la mesa
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

    -- Obtener la mesa ya actualizada
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

CREATE OR REPLACE FUNCTION public.comanda_remove_item(p_item_id bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_sale_id bigint;
    v_sale json;
BEGIN

    -- Obtener la venta a la que pertenece el artículo
    SELECT sale_id
    INTO v_sale_id
    FROM public.sale_items
    WHERE id = p_item_id
    LIMIT 1;

    IF v_sale_id IS NULL THEN
        RAISE EXCEPTION 'No se encontró el artículo de la comanda.';
    END IF;

    -- Verificar que la mesa siga abierta
    IF NOT EXISTS (
        SELECT 1
        FROM public.sales
        WHERE id = v_sale_id
          AND status = 'abierta'
    ) THEN
        RAISE EXCEPTION 'La mesa ya no está abierta.';
    END IF;

    -- Eliminar el artículo
    DELETE FROM public.sale_items
    WHERE id = p_item_id;

    -- Recalcular el total de la mesa
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

    -- Obtener la mesa actualizada
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
