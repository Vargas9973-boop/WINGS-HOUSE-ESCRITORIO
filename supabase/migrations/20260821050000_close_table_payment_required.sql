-- Auditoría Comandas 2026-08-21: close_table (20260820020000_rpc_branch_id_core_sales.sql)
-- ya valida sucursal (WHERE branch_id = p_branch_id ... FOR UPDATE) y ya
-- exige status='abierta', pero el cobro en sí no era obligatorio del lado
-- del servidor: `payment_method = COALESCE(NULLIF(p_payment_method, ''),
-- 'efectivo')` normalizaba en silencio un método vacío/NULL a 'efectivo', y
-- el chequeo `p_amount_received < v_total` solo corría `IF p_amount_received
-- IS NOT NULL` -- si venía NULL, se saltaba por completo, permitiendo cerrar
-- la mesa sin validar que se recibió lo suficiente. comandas-renderer.js
-- (el único caller real hoy) siempre manda ambos valores, así que esto nunca
-- se vio desde la UI real -- pero close_table es GRANT a anon, llamable
-- directo por REST con la anon key ya expuesta del lado del cliente, igual
-- que el hallazgo ya corregido en update_kds_status
-- (20260821030000_kds_status_transition_guard.sql). Único cambio: exige
-- p_payment_method en ('efectivo','tarjeta','transferencia') y, si es
-- 'efectivo', exige p_amount_received no nulo y >= total. Todo lo demás
-- (branch check, status='abierta', descuento de stock, folio) queda igual.
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

    v_folio := public.wh_next_folio();

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
