-- Temporal: ACL cruda (proacl) de get_branch_kds_secret para entender por
-- qué anon sigue pudiendo llamarla pese al REVOKE.
CREATE OR REPLACE FUNCTION public.tmp_debug_acl(p_name text)
 RETURNS json
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT json_build_object(
    'proname', p.proname,
    'oid', p.oid::text,
    'proowner', pg_get_userbyid(p.proowner),
    'proacl', p.proacl::text
  )
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = p_name
  LIMIT 1;
$function$;
GRANT EXECUTE ON FUNCTION public.tmp_debug_acl(text) TO anon;
