-- Temporal: definiciones en vivo de todo lo que sigue anon-callable
-- (Fase 2C) + confirmación de cuáles de las MEDIO no existen todavía.
CREATE OR REPLACE FUNCTION public.tmp_introspect_fase2c_defs()
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
      'create_product','update_product','remove_product','adjust_product_stock','update_modifier',
      'update_promotion','set_recipes_for_product','create_cost','remove_cost',
      'comanda_open_table','comanda_open_takeout','comanda_add_item','comanda_update_item_qty',
      'comanda_remove_item','comanda_assign_driver','update_kds_status','migrate_alitas_boneless_categories'
    );
$function$;
GRANT EXECUTE ON FUNCTION public.tmp_introspect_fase2c_defs() TO anon;

CREATE OR REPLACE FUNCTION public.tmp_introspect_fase2c_missing()
 RETURNS json
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT json_agg(row_to_json(t)) FROM (
    SELECT x.name, (
      SELECT count(*) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = x.name
    ) AS live_count
    FROM unnest(ARRAY[
      'remove_promotion','create_inventory_item','update_inventory_item','remove_inventory_item',
      'add_inventory_stock','create_driver','create_waste_entry','comanda_add_item_with_modifiers',
      'comanda_update_delivery_status','set_sale_cashier','set_sale_item_notes_and_modifiers','mark_sale_printed'
    ]) AS x(name)
  ) t;
$function$;
GRANT EXECUTE ON FUNCTION public.tmp_introspect_fase2c_missing() TO anon;

-- Lista completa y actual de todo lo que sigue con EXECUTE para anon (para
-- no dejar nada fuera de la Fase 2C por descuido).
CREATE OR REPLACE FUNCTION public.tmp_introspect_still_anon()
 RETURNS json
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  ) t;
$function$;
GRANT EXECUTE ON FUNCTION public.tmp_introspect_still_anon() TO anon;
