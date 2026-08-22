-- Opción A -- HALLAZGO CRÍTICO 2026-08-20: db.js (getKdsOrders) y
-- catalog-renderer.js ya llaman hoy a get_all_product_components_by_branch/
-- get_components_for_product/set_components_for_product/
-- get_product_modifier_groups_by_branch/set_product_modifier_group/
-- get_recipes_for_product/set_recipes_for_product/get_recipe_cost/
-- get_all_recipes_with_stock/get_product_ids_with_recipe/
-- get_all_recipe_costs asumiendo que existen (la memoria del proyecto decía
-- que 20260820080000_catalog_by_branch.sql -- que las define -- ya se había
-- aplicado completo en prod). Verificado 2026-08-20 vía REST directo
-- (POST .../rest/v1/rpc/<función> con la anon key real del proyecto): las
-- 11 devuelven PGRST202 "Could not find the function" -- NINGUNA existe en
-- prod. Solo se aplicó el tramo de 080000 que quedó capturado en 000011
-- (categories, products.category_id, product_components.branch_id, RLS,
-- get_menu_by_branch, get_modifiers_by_branch, clone_catalog_to_branch) --
-- la memoria estaba desactualizada en ese punto, se corrige aparte.
--
-- Efecto real ahora mismo: getKdsOrders() truena en CADA llamada (KDS de
-- escritorio no carga NINGUNA orden, no solo "no muestra combos") porque
-- llama get_all_product_components_by_branch y el error no está atrapado
-- ahí -- must(compErr, ...) lanza. Prioridad más alta que cualquier otra
-- cosa de esta sesión.
--
-- Este archivo recrea esas 11 funciones (cuerpo idéntico al ya escrito y
-- revisado en 080000 -- columnas ya verificadas contra el esquema real por
-- esta sesión: product_components(id, parent_product_id,
-- component_product_id, qty, created_at), product_modifier_groups(id,
-- product_id, group_name, qty, created_at), recipes(id, product_id,
-- insumo_id, quantity_needed) -- ninguna de las 3 tiene branch_id propio,
-- se acotan vía JOIN a products.branch_id) y las deja realmente aplicadas.
-- No se toca RLS de recipes/product_modifier_groups aquí (siguen con
-- allow_anon_all, ver 20260820031000_close_recipes_and_groups_reads.sql
-- para ese cierre) ni la de product_components (ya está en
-- deny_anon_direct desde antes, confirmado por el usuario -- este archivo
-- es lo que la destraba sin reabrir acceso directo).

-- ==========================================================================
-- 1. product_modifier_groups
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.get_product_modifier_groups_by_branch(p_branch_id bigint)
RETURNS SETOF public.product_modifier_groups
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT pmg.* FROM public.product_modifier_groups pmg
  JOIN public.products p ON p.id = pmg.product_id
  WHERE p.branch_id = p_branch_id;
$$;

CREATE OR REPLACE FUNCTION public.set_product_modifier_group(p_branch_id bigint, p_product_id bigint, p_group_name text, p_enabled boolean, p_qty integer DEFAULT 1)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró el producto % en esta sucursal', p_product_id;
  END IF;

  DELETE FROM public.product_modifier_groups WHERE product_id = p_product_id AND group_name = p_group_name;

  IF p_enabled THEN
    INSERT INTO public.product_modifier_groups (product_id, group_name, qty)
    VALUES (p_product_id, p_group_name, GREATEST(1, COALESCE(p_qty, 1)));
  END IF;
  RETURN true;
END;
$$;

-- ==========================================================================
-- 2. product_components (combos)
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.get_components_for_product(p_branch_id bigint, p_product_id bigint)
RETURNS TABLE (id bigint, parent_product_id bigint, component_product_id bigint, qty numeric, component_name text, component_price numeric)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT pc.id, pc.parent_product_id, pc.component_product_id, pc.qty, c.name, c.price
  FROM public.product_components pc
  JOIN public.products p ON p.id = pc.parent_product_id
  JOIN public.products c ON c.id = pc.component_product_id
  WHERE p.branch_id = p_branch_id AND pc.parent_product_id = p_product_id;
$$;

CREATE OR REPLACE FUNCTION public.set_components_for_product(p_branch_id bigint, p_product_id bigint, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row jsonb; v_count integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró el producto % en esta sucursal', p_product_id;
  END IF;

  DELETE FROM public.product_components WHERE parent_product_id = p_product_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) LOOP
    IF (v_row->>'component_product_id') IS NULL
       OR (v_row->>'component_product_id')::bigint = p_product_id
       OR COALESCE((v_row->>'qty')::numeric, 0) <= 0
    THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = (v_row->>'component_product_id')::bigint AND branch_id = p_branch_id) THEN
      RAISE EXCEPTION 'El componente % no pertenece a esta sucursal', v_row->>'component_product_id';
    END IF;
    INSERT INTO public.product_components (parent_product_id, component_product_id, qty)
    VALUES (p_product_id, (v_row->>'component_product_id')::bigint, (v_row->>'qty')::numeric);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_all_product_components_by_branch(p_branch_id bigint)
RETURNS TABLE (id bigint, parent_product_id bigint, parent_name text, component_product_id bigint, component_name text, qty numeric)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT pc.id, pc.parent_product_id, p.name, pc.component_product_id, c.name, pc.qty
  FROM public.product_components pc
  JOIN public.products p ON p.id = pc.parent_product_id
  JOIN public.products c ON c.id = pc.component_product_id
  WHERE p.branch_id = p_branch_id;
$$;

-- ==========================================================================
-- 3. recipes
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.get_recipes_for_product(p_branch_id bigint, p_product_id bigint)
RETURNS TABLE (id bigint, product_id bigint, insumo_id bigint, quantity_needed numeric, insumo_name text, insumo_unit text, insumo_stock numeric, insumo_cost_per_unit numeric)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.product_id, r.insumo_id, r.quantity_needed, i.name, i.unit, i.stock, i.cost_per_unit
  FROM public.recipes r
  JOIN public.products p ON p.id = r.product_id
  JOIN public.inventory i ON i.id = r.insumo_id
  WHERE p.branch_id = p_branch_id AND r.product_id = p_product_id;
$$;

CREATE OR REPLACE FUNCTION public.set_recipes_for_product(p_branch_id bigint, p_product_id bigint, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row jsonb; v_count integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró el producto % en esta sucursal', p_product_id;
  END IF;

  DELETE FROM public.recipes WHERE product_id = p_product_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) LOOP
    IF (v_row->>'insumo_id') IS NULL OR COALESCE((v_row->>'quantity_needed')::numeric, 0) <= 0 THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.inventory WHERE id = (v_row->>'insumo_id')::bigint AND branch_id = p_branch_id) THEN
      RAISE EXCEPTION 'El insumo % no pertenece a esta sucursal', v_row->>'insumo_id';
    END IF;
    INSERT INTO public.recipes (product_id, insumo_id, quantity_needed)
    VALUES (p_product_id, (v_row->>'insumo_id')::bigint, (v_row->>'quantity_needed')::numeric);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_recipe_cost(p_branch_id bigint, p_product_id bigint)
RETURNS numeric
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT SUM(r.quantity_needed * COALESCE(i.cost_per_unit, 0))
  FROM public.recipes r
  JOIN public.products p ON p.id = r.product_id
  JOIN public.inventory i ON i.id = r.insumo_id
  WHERE p.branch_id = p_branch_id AND r.product_id = p_product_id;
$$;

CREATE OR REPLACE FUNCTION public.get_all_recipes_with_stock(p_branch_id bigint)
RETURNS TABLE (product_id bigint, product_name text, insumo_id bigint, insumo_name text, insumo_unit text, insumo_stock numeric, insumo_min_stock numeric, quantity_needed numeric)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT r.product_id, p.name, r.insumo_id, i.name, i.unit, i.stock, i.min_stock, r.quantity_needed
  FROM public.recipes r
  JOIN public.products p ON p.id = r.product_id
  JOIN public.inventory i ON i.id = r.insumo_id
  WHERE p.branch_id = p_branch_id;
$$;

CREATE OR REPLACE FUNCTION public.get_product_ids_with_recipe(p_branch_id bigint)
RETURNS TABLE (product_id bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT r.product_id
  FROM public.recipes r
  JOIN public.products p ON p.id = r.product_id
  WHERE p.branch_id = p_branch_id;
$$;

CREATE OR REPLACE FUNCTION public.get_all_recipe_costs(p_branch_id bigint)
RETURNS TABLE (product_id bigint, cost numeric)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT r.product_id, SUM(r.quantity_needed * COALESCE(i.cost_per_unit, 0))
  FROM public.recipes r
  JOIN public.products p ON p.id = r.product_id
  JOIN public.inventory i ON i.id = r.insumo_id
  WHERE p.branch_id = p_branch_id
  GROUP BY r.product_id;
$$;

-- ==========================================================================
-- 4. GRANTS
-- ==========================================================================
GRANT EXECUTE ON FUNCTION public.get_product_modifier_groups_by_branch(bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.set_product_modifier_group(bigint, bigint, text, boolean, integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_components_for_product(bigint, bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.set_components_for_product(bigint, bigint, jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.get_all_product_components_by_branch(bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.get_recipes_for_product(bigint, bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.set_recipes_for_product(bigint, bigint, jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.get_recipe_cost(bigint, bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.get_all_recipes_with_stock(bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.get_product_ids_with_recipe(bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.get_all_recipe_costs(bigint) TO anon;
