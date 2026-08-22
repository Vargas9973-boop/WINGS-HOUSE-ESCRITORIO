-- Auditoría KDS 2026-08-21: update_kds_status (20260820020000_rpc_branch_id_core_sales.sql)
-- ya valida sucursal correctamente (UPDATE ... WHERE branch_id = p_branch_id
-- + RAISE EXCEPTION si no encuentra fila), pero NUNCA compara p_status contra
-- el kds_status ACTUAL de la venta -- nada impedía pasar 'nueva' -> 'entregada'
-- de un salto. kds-preload.js siempre pide el siguiente paso lógico
-- (cook/markReady/markDelivered = en_preparacion/lista/entregada según el
-- estado que ya muestra la tarjeta), así que un salto ilegal nunca sale de la
-- UI real -- pero la función está GRANT a anon y es llamable directo por REST
-- con la anon key (ya expuesta del lado del cliente en este proyecto), y un
-- salto así dejaría kds_started_at/kds_ready_at en NULL con kds_delivered_at
-- puesto, y cerraría una venta 'Llevar' a 'completada' sin haber pasado por
-- cocina. Único cambio: agrega el guard de transición: mismo estado = no-op
-- (evita error de doble clic/carrera), un paso adelante = ok, cualquier otra
-- cosa (salto o retroceso) = excepción. Todo lo demás (branch check,
-- columnas de timestamp, cierre de 'Llevar' a 'completada') queda idéntico.
CREATE OR REPLACE FUNCTION public.update_kds_status(p_branch_id bigint, p_sale_id bigint, p_status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_client_type text;
  v_current_status text;
  v_next_by_current CONSTANT jsonb := '{
    "nueva": "en_preparacion",
    "en_preparacion": "lista",
    "lista": "entregada"
  }'::jsonb;
BEGIN
  IF p_status NOT IN ('nueva', 'en_preparacion', 'lista', 'entregada') THEN
    RAISE EXCEPTION 'Estado de KDS inválido: %', p_status;
  END IF;

  SELECT client_type, kds_status INTO v_client_type, v_current_status
  FROM public.sales
  WHERE id = p_sale_id AND branch_id = p_branch_id;

  IF v_current_status IS NULL THEN
    RAISE EXCEPTION 'No se encontró la orden % en esta sucursal', p_sale_id;
  END IF;

  IF p_status = v_current_status THEN
    RETURN true; -- no-op idempotente (doble clic / carrera de refresco)
  END IF;

  IF v_next_by_current->>v_current_status IS DISTINCT FROM p_status THEN
    RAISE EXCEPTION
      'Transición de KDS inválida: % -> % (la orden % está en %)',
      v_current_status, p_status, p_sale_id, v_current_status;
  END IF;

  UPDATE public.sales
  SET kds_status = p_status,
      kds_started_at = CASE WHEN p_status = 'en_preparacion' THEN now() ELSE kds_started_at END,
      kds_ready_at = CASE WHEN p_status = 'lista' THEN now() ELSE kds_ready_at END,
      kds_delivered_at = CASE WHEN p_status = 'entregada' THEN now() ELSE kds_delivered_at END,
      status = CASE WHEN p_status = 'entregada' AND v_client_type = 'Llevar' THEN 'completada' ELSE status END
  WHERE id = p_sale_id
    AND branch_id = p_branch_id;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_kds_status(bigint, bigint, text) TO anon;

-- Verificación de higiene (no se esperan filas: sales.branch_id tiene DEFAULT
-- desde 20260815070000_branch_and_ticket_schema.sql y process_sale siempre
-- manda p_branch_id explícito, validado contra branches). Si alguna vez
-- quedó una fila NULL por una vía distinta, esto la repara sin tocar nada más.
UPDATE public.sales SET branch_id = 1 WHERE branch_id IS NULL;

-- NO se agrega un índice (branch_id, kds_status): idx_sales_kds_status_pending
-- (20260818040000_kds_status.sql) ya es un índice parcial sobre (created_at)
-- WHERE kds_status <> 'entregada' -- exactamente el filtro que usa
-- getKdsOrders(), y ese conjunto (órdenes aún no entregadas) es chico por
-- diseño sin importar cuántas sucursales existan; sumado a idx_sales_branch_id
-- (creado en 20260815070000 para todas las tablas con branch_id), un índice
-- compuesto nuevo no aportaría nada medible aquí.
