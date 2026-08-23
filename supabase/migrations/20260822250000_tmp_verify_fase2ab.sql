-- Temporal: verificación post Fase 2A/2B (overloads y grants). Se borra a
-- sí misma al final de este mismo archivo.
CREATE OR REPLACE FUNCTION public.tmp_verify_fase2ab()
 RETURNS json
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT json_build_object(
    'process_sale_overloads', (SELECT count(*) FROM pg_proc WHERE proname = 'process_sale'),
    'total_functions', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'),
    'still_anon_critical', (
      SELECT json_agg(p.proname) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'process_sale','close_table','get_sale_items_summary','get_sale_items_with_modifiers',
          'get_all_recipe_costs','get_recipe_cost','get_roles_by_branch','get_role_permissions',
          'get_user_permissions','liquidate_driver_sales','create_role','update_role','remove_role',
          'set_role_permissions','set_branch_setting','create_payroll_deduction','upsert_payroll_history',
          'close_payroll_deductions','update_sale_payment_status','update_employee','remove_employee',
          'save_fingerprint','clear_fingerprint','set_cash_cut_fondo_inicial','close_cash_cut',
          'create_cash_movement','remove_cash_movement'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.role_routine_grants g
          WHERE g.specific_name = p.proname || '_' || p.oid
            AND g.privilege_type = 'EXECUTE' AND g.grantee = 'anon'
        )
    ),
    'missing_still' , (
      SELECT json_agg(x.name) FROM unnest(ARRAY[
        'update_employee','remove_employee','save_fingerprint','clear_fingerprint',
        'update_sale_payment_status','set_cash_cut_fondo_inicial','close_cash_cut',
        'create_cash_movement','remove_cash_movement'
      ]) AS x(name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_proc p2 JOIN pg_namespace n2 ON n2.oid = p2.pronamespace WHERE n2.nspname='public' AND p2.proname = x.name)
    )
  );
$function$;
GRANT EXECUTE ON FUNCTION public.tmp_verify_fase2ab() TO anon;
