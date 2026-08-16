-- Pedidos "para llevar": comandas sin mesa asignada. Reusa el mismo motor
-- que las comandas de mesa (comanda_add_item / comanda_update_item_qty /
-- comanda_remove_item / close_table / cancel_table ya operan por sale_id y
-- no les importa si table_number es NULL), así que solo hace falta una
-- función para abrir el pedido: a diferencia de comanda_open_table, aquí
-- cada clic crea una comanda nueva (no hay "la mesa 4" que reutilizar, un
-- cliente puede pedir varias veces para llevar en el mismo turno).
CREATE OR REPLACE FUNCTION public.comanda_open_takeout(p_opened_by text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_id bigint;
BEGIN
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
        'Para llevar',
        'efectivo',
        0,
        'abierta',
        NULL,
        p_opened_by,
        false
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$function$;
