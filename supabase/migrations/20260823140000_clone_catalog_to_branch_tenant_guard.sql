-- Auditoría de Catálogo/Inventario 2026-08-23: clone_catalog_to_branch
-- (usada para poblar el catálogo de una sucursal nueva a partir de otra) es
-- la única RPC de todo el módulo de catálogo sin ningún guard de sesión ni
-- de tenant -- a diferencia de create_product/update_product/
-- get_products_by_branch/etc., que todos validan p_branch_id contra
-- current_branch_id()/current_visible_branch_ids(). Solo comprobaba que
-- p_target_branch_id existiera como fila de `branches`, nada más.
--
-- GRANT EXECUTE TO authenticated ya estaba puesto (pg_proc/
-- role_routine_grants confirmado en vivo) y NINGÚN caller real la usa hoy
-- (cero referencias en db.js, wing-house-web/src o scripts/onboard-tenant.js
-- -- confirmado por grep). Eso la deja como una RPC muerta para la app pero
-- viva para REST: cualquier usuario autenticado de CUALQUIER tenant podía
-- llamarla directo con `p_source_branch_id` = una sucursal de OTRO negocio
-- y `p_target_branch_id` = la suya, y clonarse el catálogo completo (nombre/
-- precio/categorías/modificadores) de ese otro negocio -- fuga cross-tenant
-- real, aunque nunca explotada por la UI existente.
--
-- Fix: mismo patrón que current_visible_branch_ids() usa para el rol dueño
-- -- exige que origen y destino sean sucursales del MISMO tenant (nunca
-- cruza negocios) y que quien llama tenga visibilidad real de ambas
-- sucursales (su propia sucursal, o dueño del tenant). No se toca ningún
-- caller porque no hay ninguno; si en el futuro el onboarding de sucursales
-- nuevas necesita esto, ya queda seguro para usarse.

CREATE OR REPLACE FUNCTION public.clone_catalog_to_branch(p_source_branch_id bigint, p_target_branch_id bigint)
 RETURNS TABLE(cloned_products integer, cloned_categories integer, cloned_modifiers integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prod INT; v_cat INT; v_mod INT;
  v_source_tenant bigint;
  v_target_tenant bigint;
BEGIN
  SELECT tenant_id INTO v_source_tenant FROM public.branches WHERE id = p_source_branch_id;
  SELECT tenant_id INTO v_target_tenant FROM public.branches WHERE id = p_target_branch_id;

  IF v_target_tenant IS NULL THEN
    RAISE EXCEPTION 'Branch destino % no existe', p_target_branch_id;
  END IF;

  IF v_source_tenant IS NULL THEN
    RAISE EXCEPTION 'Branch origen % no existe', p_source_branch_id;
  END IF;

  IF v_source_tenant IS DISTINCT FROM v_target_tenant THEN
    RAISE EXCEPTION 'branch mismatch: origen y destino deben ser del mismo tenant';
  END IF;

  IF NOT (p_source_branch_id = ANY (COALESCE(public.current_visible_branch_ids(), ARRAY[]::bigint[])))
     OR NOT (p_target_branch_id = ANY (COALESCE(public.current_visible_branch_ids(), ARRAY[]::bigint[]))) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  -- Clonar categorías
  INSERT INTO categories (name, branch_id)
  SELECT name, p_target_branch_id FROM categories WHERE branch_id=p_source_branch_id
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_cat = ROW_COUNT;

  -- Clonar productos
  INSERT INTO products (name, price, category_id, category, active, sort_order, stock, employee_price, branch_id)
  SELECT p.name, p.price,
         (SELECT id FROM categories WHERE name=(SELECT name FROM categories WHERE id=p.category_id) AND branch_id=p_target_branch_id LIMIT 1),
         p.category, p.active, p.sort_order, p.stock, p.employee_price, p_target_branch_id
  FROM products p WHERE p.branch_id=p_source_branch_id
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_prod = ROW_COUNT;

  -- Clonar modifiers
  INSERT INTO modifiers (name, group_name, price_extra, is_required, is_active, active, qty_needed, branch_id)
  SELECT name, group_name, price_extra, is_required, is_active, active, qty_needed, p_target_branch_id
  FROM modifiers WHERE branch_id=p_source_branch_id
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_mod = ROW_COUNT;

  RETURN QUERY SELECT v_prod, v_cat, v_mod;
END; $function$;
