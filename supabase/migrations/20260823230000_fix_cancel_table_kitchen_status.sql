-- Bug real reportado en vivo: comandaCancelTable (db.js) revienta con
-- "new row for relation sales violates check constraint
-- sales_kitchen_status_check". Causa: cancel_table (definida en
-- 20260822340000_fase2c_stragglers.sql) hace
--   UPDATE sales SET status='cancelada', kitchen_status='cancelada' ...
-- pero sales_kitchen_status_check (wing-house-web/supabase/migrations/
-- 0003_kitchen_status_final.sql) solo permite kitchen_status en
-- ('pendiente','en_cocina','listo','entregado') -- 'cancelada' nunca fue
-- un valor válido de esa columna.
--
-- No hace falta agregar 'cancelada' al constraint: comanda_board (misma
-- migración 0003) ya filtra `where status = 'abierta'`, así que una vez
-- que status pasa a 'cancelada' la fila desaparece del tablero sin
-- importar qué traiga kitchen_status. Se quita ese SET inválido y se deja
-- kitchen_status tal como estaba al cancelar.
CREATE OR REPLACE FUNCTION public.cancel_table(p_sale_id bigint, p_branch_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;
  UPDATE public.sales SET status='cancelada'
  WHERE id=p_sale_id AND branch_id=p_branch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Venta % no existe en branch %', p_sale_id, p_branch_id; END IF;
END; $function$;
