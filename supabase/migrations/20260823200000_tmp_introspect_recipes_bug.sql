-- Temporal: diagnóstico del bug reportado 2026-08-23 -- "No se pudo cargar
-- el catálogo" en Ventas, consola: "Error: No se pudo obtener las recetas
-- con existencia: structure of query does not match function result type."
-- (get_all_recipes_with_stock). Se borra en 20260823210000 (la migración
-- que aplica el fix real), mismo patrón que
-- 20260822200000_tmp_introspect_anon_rpcs.sql.
CREATE OR REPLACE FUNCTION public.tmp_introspect_recipes_bug()
 RETURNS json
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT json_build_object(
    'recipes_columns', (
      SELECT json_agg(json_build_object('column_name', column_name, 'data_type', data_type))
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'recipes'
    ),
    'products_columns', (
      SELECT json_agg(json_build_object('column_name', column_name, 'data_type', data_type))
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products'
    ),
    'inventory_columns', (
      SELECT json_agg(json_build_object('column_name', column_name, 'data_type', data_type))
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'inventory'
    ),
    'get_all_recipes_with_stock_defs', (
      SELECT json_agg(pg_get_functiondef(p.oid))
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_all_recipes_with_stock'
    ),
    'get_all_recipes_with_stock_overload_count', (
      SELECT count(*) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_all_recipes_with_stock'
    )
  );
$function$;
GRANT EXECUTE ON FUNCTION public.tmp_introspect_recipes_bug() TO anon;
