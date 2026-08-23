CREATE OR REPLACE FUNCTION public.tmp_introspect_payroll_attendance()
 RETURNS json
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT json_object_agg(p.oid::text, json_build_object('name', p.proname, 'def', pg_get_functiondef(p.oid)))
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'register_attendance','set_payroll_bonus','get_payroll_week_credit','create_employee',
      'get_sale_employee_breakdown','get_employee_daily_consumption',
      'update_employee','remove_employee','save_fingerprint','clear_fingerprint'
    );
$function$;
GRANT EXECUTE ON FUNCTION public.tmp_introspect_payroll_attendance() TO anon;

-- columnas reales de employees (para saber si hay algún link a auth.uid())
CREATE OR REPLACE FUNCTION public.tmp_introspect_employees_cols()
 RETURNS json
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT json_agg(row_to_json(t)) FROM (
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'employees'
    ORDER BY ordinal_position
  ) t;
$function$;
GRANT EXECUTE ON FUNCTION public.tmp_introspect_employees_cols() TO anon;
