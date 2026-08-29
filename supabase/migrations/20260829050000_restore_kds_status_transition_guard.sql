-- Auditoría de tenant 2 (La Xalapeña) 2026-08-29: regresión real encontrada
-- ejercitando update_kds_status en vivo (dentro de una transacción con
-- ROLLBACK, sin persistir nada -- ver scripts/check-phantom-columns.mjs
-- para la clase de auditoría hermana). update_kds_status(branch, sale,
-- 'lista') tuvo éxito partiendo de 'nueva', saltándose 'en_preparacion' --
-- el guard de transición agregado en 20260821030000_kds_status_transition_guard.sql
-- (mismo estado = no-op, un paso adelante = ok, cualquier salto/retroceso =
-- excepción) ya no está.
--
-- Causa raíz: 20260822310000_fase2c_medio_authz.sql (Fase 2C, endurecimiento
-- de autorización) volvió a definir update_kds_status para agregarle el
-- chequeo `p_branch_id IS DISTINCT FROM current_branch_id()`, pero partiendo
-- de una copia vieja de la función (la de 20260820020000, anterior al guard
-- de transición) en vez de la de 20260821030000 -- CREATE OR REPLACE
-- reemplaza toda la función, así que el guard de transición quedó
-- pisado sin que nadie lo notara (ambos cambios tocan la misma función en
-- fechas distintas, ninguno depende del otro en el código). Afecta a AMBOS
-- tenants por igual -- no es un bug de un tenant en particular.
--
-- Fix: fusiona los dos cambios en una sola versión -- mantiene el chequeo de
-- sucursal vía current_branch_id() (2026-08-22, correcto y más nuevo, no se
-- toca) y restaura el guard de transición (2026-08-21). Nada más cambia:
-- mismas columnas de timestamp, mismo cierre de 'Llevar' a 'completada'.
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
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

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
