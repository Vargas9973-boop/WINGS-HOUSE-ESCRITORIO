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
