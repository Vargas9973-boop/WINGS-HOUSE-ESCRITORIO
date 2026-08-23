-- Temporal: introspección de las definiciones EN VIVO de los RPC
-- anon-callable antes de reescribirlos (Fase 2A/2B/2C del audit
-- multi-tenant) -- mismo patrón que 20260815060100_tmp_func_defs.sql. Se
-- borra en la migración que aplique los fixes reales.
CREATE OR REPLACE FUNCTION public.tmp_introspect_anon_rpcs()
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
      'get_sale_items_summary','get_sale_items_with_modifiers','get_all_recipe_costs','get_recipe_cost',
      'get_user_permissions','get_roles_by_branch','get_role_permissions','get_menu_by_branch',
      'get_modifiers_by_branch','get_products_by_branch','get_components_for_product',
      'get_all_product_components_by_branch','get_product_modifier_groups_by_branch',
      'get_recipes_for_product','get_all_recipes_with_stock','get_product_ids_with_recipe',
      'process_sale','close_table','liquidate_driver_sales','update_sale_payment_status',
      'set_cash_cut_fondo_inicial','close_cash_cut','create_cash_movement','remove_cash_movement',
      'update_employee','remove_employee','save_fingerprint','clear_fingerprint',
      'create_role','update_role','remove_role','set_role_permissions',
      'set_branch_setting','create_payroll_deduction','upsert_payroll_history','close_payroll_deductions',
      'comanda_open_table','comanda_open_takeout','comanda_add_item','comanda_add_item_with_modifiers',
      'comanda_update_item_qty','comanda_remove_item','comanda_update_delivery_status','comanda_assign_driver',
      'set_sale_cashier','set_sale_item_notes_and_modifiers','update_kds_status','mark_sale_printed',
      'create_product','update_product','remove_product','adjust_product_stock','update_modifier',
      'create_promotion','update_promotion','remove_promotion','set_product_modifier_group',
      'set_components_for_product','create_inventory_item','update_inventory_item','remove_inventory_item',
      'add_inventory_stock','create_cost','remove_cost','create_driver','create_waste_entry',
      'migrate_alitas_boneless_categories'
    );
$function$;
GRANT EXECUTE ON FUNCTION public.tmp_introspect_anon_rpcs() TO anon;

-- Lista aparte: cuáles de esos nombres tienen más de un overload vivo hoy
-- (el mismo bug que ya se encontró una vez con comanda_set_delivery) --
-- para no asumir que "un CREATE OR REPLACE con la firma de la última
-- migración" alcanza.
CREATE OR REPLACE FUNCTION public.tmp_introspect_overload_counts()
 RETURNS json
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT json_object_agg(p.proname, cnt) FROM (
    SELECT p.proname, count(*) cnt
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
    GROUP BY p.proname
    HAVING count(*) > 1
  ) p;
$function$;
GRANT EXECUTE ON FUNCTION public.tmp_introspect_overload_counts() TO anon;
