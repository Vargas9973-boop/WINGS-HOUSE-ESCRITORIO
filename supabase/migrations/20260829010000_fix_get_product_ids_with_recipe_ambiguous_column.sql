-- Fix: get_product_ids_with_recipe (recreada en 20260822310000_fase2c_medio_authz.sql
-- como plpgsql) hace `SELECT DISTINCT product_id FROM public.recipes WHERE
-- branch_id = p_branch_id` sin calificar la columna. En plpgsql, el nombre de
-- columna de RETURNS TABLE(product_id bigint) es visible como si fuera una
-- variable dentro de la función, así que "product_id" queda ambiguo contra
-- recipes.product_id -- Postgres devuelve "column reference "product_id" is
-- ambiguous". Esto rompe el catálogo: catalog-renderer.js no puede cargar el
-- soporte de recetas al dar de alta/editar un producto.
CREATE OR REPLACE FUNCTION public.get_product_ids_with_recipe(p_branch_id bigint)
 RETURNS TABLE(product_id bigint)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (p_branch_id = ANY (COALESCE(public.current_visible_branch_ids(), ARRAY[]::bigint[]))) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;
  RETURN QUERY SELECT DISTINCT r.product_id FROM public.recipes r WHERE r.branch_id = p_branch_id;
END;
$function$;
