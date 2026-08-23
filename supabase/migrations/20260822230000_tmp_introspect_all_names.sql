-- Temporal, parte 4: lista completa de las 85 funciones que SÍ existen hoy
-- en public, para dejar de adivinar y comparar 1:1 contra lo que db.js
-- necesita.
CREATE OR REPLACE FUNCTION public.tmp_introspect_all_names()
 RETURNS json
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT json_agg(row_to_json(t)) FROM (
    SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
    ORDER BY p.proname
  ) t;
$function$;
GRANT EXECUTE ON FUNCTION public.tmp_introspect_all_names() TO anon;
