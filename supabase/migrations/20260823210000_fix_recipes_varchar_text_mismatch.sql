-- Fix del bug reportado 2026-08-23: al entrar a Ventas, alerta roja "No se
-- pudo cargar el catálogo", consola mostraba "Error: No se pudo obtener las
-- recetas con existencia: structure of query does not match function
-- result type." (RPC get_all_recipes_with_stock).
--
-- Causa raíz confirmada vía introspección en vivo
-- (tmp_introspect_recipes_bug, migración anterior): products.name,
-- inventory.name e inventory.unit son "character varying" en prod, pero
-- 20260822310000_fase2c_medio_authz.sql reescribió get_all_recipes_with_stock
-- (y 3 funciones hermanas) en LANGUAGE plpgsql con RETURN QUERY declarando
-- esas columnas como "text". A diferencia de un SELECT normal (donde
-- varchar->text castea implícito sin problema), RETURN QUERY en PL/pgSQL
-- exige que el tupdesc de la query coincida EXACTO con el RETURNS TABLE
-- declarado -- no aplica el cast de asignación automáticamente. Esa misma
-- migración ya lo había resuelto correctamente para get_menu_by_branch
-- (declara "product_name character varying", línea 751) pero el fix no se
-- propagó a estas otras 4 funciones que también leen products.name/
-- inventory.name/inventory.unit.
--
-- Fix: cast explícito ::text en el SELECT de cada función afectada (más
-- simple que cambiar el RETURNS TABLE a character varying en las 4, y no
-- rompe nada del lado del cliente -- db.js/sales-renderer.js ya tratan
-- estos campos como string JS de cualquier forma). Mismo patrón para las
-- 4 funciones que comparten el mismo tipo de JOIN a products/inventory.

CREATE OR REPLACE FUNCTION public.get_recipes_for_product(p_branch_id bigint, p_product_id bigint)
 RETURNS TABLE(id bigint, product_id bigint, insumo_id bigint, quantity_needed numeric, insumo_name text, insumo_unit text, insumo_stock numeric, insumo_cost_per_unit numeric)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (p_branch_id = ANY (COALESCE(public.current_visible_branch_ids(), ARRAY[]::bigint[]))) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;
  RETURN QUERY
  SELECT r.id, r.product_id, r.insumo_id, r.quantity_needed, i.name::text, i.unit::text, i.stock, i.cost_per_unit
  FROM public.recipes r
  JOIN public.inventory i ON i.id = r.insumo_id
  WHERE r.branch_id = p_branch_id AND r.product_id = p_product_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_all_recipes_with_stock(p_branch_id bigint)
 RETURNS TABLE(product_id bigint, product_name text, insumo_id bigint, insumo_name text, insumo_unit text, insumo_stock numeric, insumo_min_stock numeric, quantity_needed numeric)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (p_branch_id = ANY (COALESCE(public.current_visible_branch_ids(), ARRAY[]::bigint[]))) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;
  RETURN QUERY
  SELECT r.product_id, p.name::text, r.insumo_id, i.name::text, i.unit::text, i.stock, i.min_stock, r.quantity_needed
  FROM public.recipes r
  JOIN public.products p ON p.id = r.product_id
  JOIN public.inventory i ON i.id = r.insumo_id
  WHERE r.branch_id = p_branch_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_components_for_product(p_branch_id bigint, p_product_id bigint)
 RETURNS TABLE(id bigint, parent_product_id bigint, component_product_id bigint, qty numeric, component_name text, component_price numeric)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (p_branch_id = ANY (COALESCE(public.current_visible_branch_ids(), ARRAY[]::bigint[]))) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;
  RETURN QUERY
  SELECT pc.id, pc.parent_product_id, pc.component_product_id, pc.qty, c.name::text, c.price
  FROM public.product_components pc
  JOIN public.products c ON c.id = pc.component_product_id
  WHERE pc.branch_id = p_branch_id AND pc.parent_product_id = p_product_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_all_product_components_by_branch(p_branch_id bigint)
 RETURNS TABLE(id bigint, parent_product_id bigint, parent_name text, component_product_id bigint, component_name text, qty numeric)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (p_branch_id = ANY (COALESCE(public.current_visible_branch_ids(), ARRAY[]::bigint[]))) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;
  RETURN QUERY
  SELECT pc.id, pc.parent_product_id, p.name::text, pc.component_product_id, c.name::text, pc.qty
  FROM public.product_components pc
  JOIN public.products p ON p.id = pc.parent_product_id
  JOIN public.products c ON c.id = pc.component_product_id
  WHERE pc.branch_id = p_branch_id;
END;
$function$;

-- Limpieza: ya no se necesitan los diagnósticos temporales.
DROP FUNCTION IF EXISTS public.tmp_introspect_recipes_bug();
