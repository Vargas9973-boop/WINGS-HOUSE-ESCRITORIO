-- Temporal, parte 2: 23 de los 67 nombres pedidos en
-- tmp_introspect_anon_rpcs no existen hoy en pg_proc bajo ese nombre
-- exacto -- hay que confirmar si cambiaron de nombre o si el grant que los
-- mencionaba quedó huérfano (función borrada, GRANT nunca reejecutado).
CREATE OR REPLACE FUNCTION public.tmp_introspect_missing_names()
 RETURNS json
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT json_agg(row_to_json(t)) FROM (
    SELECT
      p.proname AS name,
      pg_get_function_identity_arguments(p.oid) AS args,
      (
        SELECT json_agg(g.grantee)
        FROM information_schema.role_routine_grants g
        WHERE g.specific_name = p.proname || '_' || p.oid AND g.privilege_type = 'EXECUTE'
      ) AS grantees
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (
        p.proname ILIKE '%payment_status%' OR p.proname ILIKE '%cash_cut%' OR
        p.proname ILIKE '%employee%' OR p.proname ILIKE '%fingerprint%' OR
        p.proname ILIKE '%inventory%' OR p.proname ILIKE '%_cost%' OR
        p.proname ILIKE '%driver%' OR p.proname ILIKE '%waste%' OR
        p.proname ILIKE '%promotion%' OR p.proname ILIKE '%delivery_status%' OR
        p.proname ILIKE '%item_notes%' OR p.proname ILIKE '%printed%' OR
        p.proname ILIKE '%cash_movement%' OR p.proname ILIKE '%sale_cashier%'
      )
    ORDER BY p.proname
  ) t;
$function$;
GRANT EXECUTE ON FUNCTION public.tmp_introspect_missing_names() TO anon;
