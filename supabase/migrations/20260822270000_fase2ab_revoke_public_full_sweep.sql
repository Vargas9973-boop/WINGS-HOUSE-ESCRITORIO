-- Confirmado por prueba real contra REST (curl con la anon key): process_sale
-- y close_table siguen siendo CALLABLES por anon a nivel de permisos
-- (PostgREST llega hasta adentro de la función, que responde "branch
-- mismatch" -- el dato nunca sale, pero el permiso de EXECUTE seguía ahí).
-- El REVOKE ... FROM anon de 20260822240000 no alcanzó porque estas
-- funciones YA tenían EXECUTE otorgado a PUBLIC desde su creación
-- original (antes de esta sesión) -- anon hereda de PUBLIC sin importar
-- el REVOKE puntual a su propio rol. Mismo mecanismo que
-- 20260822260000 encontró para las 9 funciones nuevas, pero aquí aplica a
-- TODAS las de Fase 2A/2B, no solo a las nuevas. Barrido completo: REVOKE
-- FROM PUBLIC además de FROM anon en las 18 que no lo tenían ya.
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.process_sale(bigint, text, jsonb, text, numeric, numeric, text, bigint, text, text, boolean)',
    'public.close_table(bigint, bigint, numeric, text, numeric, text)',
    'public.get_sale_items_summary(bigint, timestamptz, timestamptz)',
    'public.get_sale_items_with_modifiers(bigint, bigint[])',
    'public.get_all_recipe_costs(bigint)',
    'public.get_recipe_cost(bigint, bigint)',
    'public.get_roles_by_branch(bigint)',
    'public.get_role_permissions(bigint, bigint)',
    'public.get_user_permissions(bigint)',
    'public.liquidate_driver_sales(uuid)',
    'public.create_role(bigint, text, text)',
    'public.update_role(bigint, bigint, text, text)',
    'public.remove_role(bigint, bigint)',
    'public.set_role_permissions(bigint, bigint, jsonb)',
    'public.set_branch_setting(bigint, text, text)',
    'public.create_payroll_deduction(bigint, text, numeric, bigint, text, text, date, date)',
    'public.upsert_payroll_history(bigint, jsonb)',
    'public.close_payroll_deductions(bigint, timestamptz, timestamptz)',
    'public.get_branch_kds_secret(bigint)'
  ]
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
