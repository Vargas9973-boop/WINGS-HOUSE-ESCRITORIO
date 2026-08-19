-- Temporal: descubrí en vivo que existe un segundo overload de
-- comanda_set_delivery (con p_is_delivery) que no está en ningún archivo de
-- este repo -- CREATE OR REPLACE en 20260819050000 solo reemplazó el
-- overload de 6 parámetros, dejando el otro sin el payment_status nuevo.
-- Esta función es solo para ver su definición completa y decidir el fix; se
-- borra en la siguiente migración junto con el arreglo real.
CREATE OR REPLACE FUNCTION public.tmp_introspect_delivery_fns()
 RETURNS json
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT json_object_agg(p.oid::text, pg_get_functiondef(p.oid))
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'comanda_set_delivery';
$function$;
GRANT EXECUTE ON FUNCTION public.tmp_introspect_delivery_fns() TO anon, authenticated;
