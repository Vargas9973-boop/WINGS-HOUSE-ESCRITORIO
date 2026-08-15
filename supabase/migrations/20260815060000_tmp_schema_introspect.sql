-- Temporal: introspección de esquema para planear la migración de sucursal
-- y ticket completo. Se elimina en una migración posterior.
CREATE OR REPLACE FUNCTION public.tmp_schema_introspect()
 RETURNS json
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT json_object_agg(table_name, cols) FROM (
    SELECT c.table_name, json_agg(json_build_object(
      'column', c.column_name,
      'type', c.data_type,
      'nullable', c.is_nullable,
      'default', c.column_default
    ) ORDER BY c.ordinal_position) AS cols
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name IN ('users','sales','sale_items','products','promotions','inventory','costs','attendance','employees','settings','folio_counters','payroll_weeks','branches')
    GROUP BY c.table_name
  ) t;
$function$;
GRANT EXECUTE ON FUNCTION public.tmp_schema_introspect() TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.tmp_func_defs()
 RETURNS json
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT json_object_agg(p.proname, pg_get_functiondef(p.oid))
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'process_sale', 'get_sale_employee_breakdown', 'get_employee_daily_consumption',
      'get_payroll_week_credit', 'wh_next_folio', 'set_payroll_bonus', 'create_employee',
      'register_attendance', 'set_setting'
    );
$function$;
GRANT EXECUTE ON FUNCTION public.tmp_func_defs() TO anon, authenticated;
