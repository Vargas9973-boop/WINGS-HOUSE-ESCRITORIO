CREATE OR REPLACE FUNCTION public.tmp_introspect_stragglers()
 RETURNS json
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT json_object_agg(p.oid::text, json_build_object('name', p.proname, 'def', pg_get_functiondef(p.oid)))
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('comanda_board','comanda_set_delivery','cancel_table','comanda_update_kitchen');
$function$;
GRANT EXECUTE ON FUNCTION public.tmp_introspect_stragglers() TO anon;
