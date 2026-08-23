CREATE OR REPLACE FUNCTION public.tmp_absolute_final_verify()
 RETURNS json
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT json_build_object(
    'total_functions', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'),
    'anon_still_granted', (
      SELECT json_agg(row_to_json(t)) FROM (
        SELECT DISTINCT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN information_schema.role_routine_grants g
          ON g.specific_name = p.proname || '_' || p.oid
        WHERE n.nspname = 'public'
          AND g.privilege_type = 'EXECUTE'
          AND g.grantee = 'anon'
          AND p.proname NOT LIKE 'tmp_%'
        ORDER BY p.proname
      ) t
    )
  );
$function$;
GRANT EXECUTE ON FUNCTION public.tmp_absolute_final_verify() TO anon;
