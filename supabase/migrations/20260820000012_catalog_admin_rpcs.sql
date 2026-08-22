-- Opción A -- Migración 0012: cierra la fuga de seguridad confirmada en
-- 20260820000011 (products_select/insert/update/delete y allow_anon_all
-- en modifiers/product_components seguían con USING(true), reabriendo lo
-- que deny_anon_direct intentaba bloquear -- policies permissive se
-- combinan con OR) y agrega los RPC de administración que faltaban para
-- que anon pueda seguir operando el catálogo una vez cerrado el acceso
-- directo.
--
-- Debe aplicarse junto con 20260820000011, no por separado: ese archivo
-- reproduce la fuga tal como estaba en producción; este la cierra.

-- ==========================================================================
-- 1. products -- elimina las 4 policies viejas con USING/WITH CHECK(true).
--    deny_anon_direct (creada antes de este trabajo) queda como única
--    policy para anon.
-- ==========================================================================
DROP POLICY IF EXISTS products_select ON public.products;
DROP POLICY IF EXISTS products_insert ON public.products;
DROP POLICY IF EXISTS products_update ON public.products;
DROP POLICY IF EXISTS products_delete ON public.products;

-- ==========================================================================
-- 2. modifiers / product_components -- elimina la allow_anon_all
--    duplicada creada en 20260820000011 (reflejaba la fuga real; ahora se
--    retira). deny_anon_direct queda como única policy.
-- ==========================================================================
DROP POLICY IF EXISTS allow_anon_all ON public.modifiers;
DROP POLICY IF EXISTS allow_anon_all ON public.product_components;

-- ==========================================================================
-- 3. RPC de administración -- reemplazan los .select()/.insert()/
--    .update()/.delete() directos a products/modifiers que el cierre de
--    arriba rompe (catalog-renderer.js / db.js: createProduct,
--    updateProduct, removeProduct, adjustProductStock, updateModifier, y
--    el listado completo de productos para las pantallas de
--    administración y POS/Comandas de escritorio).
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.get_products_by_branch(p_branch_id bigint)
RETURNS SETOF public.products
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.products
  WHERE branch_id = p_branch_id
  ORDER BY category, sort_order, name;
$$;

CREATE OR REPLACE FUNCTION public.create_product(
  p_branch_id bigint, p_name text, p_category text, p_price numeric,
  p_employee_price numeric, p_active boolean, p_sort_order integer, p_stock numeric
) RETURNS public.products
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.products;
BEGIN
  INSERT INTO public.products (name, category, price, employee_price, active, sort_order, stock, branch_id)
  VALUES (p_name, p_category, COALESCE(p_price, 0), p_employee_price, COALESCE(p_active, true), COALESCE(p_sort_order, 0), p_stock, p_branch_id)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_product(
  p_branch_id bigint, p_id bigint, p_name text, p_category text, p_price numeric,
  p_employee_price numeric, p_active boolean, p_sort_order integer, p_stock numeric
) RETURNS public.products
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.products;
BEGIN
  UPDATE public.products
  SET name = p_name, category = p_category, price = COALESCE(p_price, 0), employee_price = p_employee_price,
      active = COALESCE(p_active, true), sort_order = COALESCE(p_sort_order, 0), stock = p_stock
  WHERE id = p_id AND branch_id = p_branch_id
  RETURNING * INTO v_row;
  IF v_row IS NULL THEN RAISE EXCEPTION 'No se encontró el producto % en esta sucursal', p_id; END IF;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.adjust_product_stock(p_branch_id bigint, p_id bigint, p_delta numeric)
RETURNS public.products
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.products;
BEGIN
  SELECT * INTO v_row FROM public.products WHERE id = p_id AND branch_id = p_branch_id;
  IF v_row IS NULL THEN RAISE EXCEPTION 'No se encontró el producto % en esta sucursal', p_id; END IF;
  IF v_row.stock IS NULL THEN RETURN v_row; END IF;

  UPDATE public.products SET stock = GREATEST(0, COALESCE(stock, 0) + p_delta)
  WHERE id = p_id AND branch_id = p_branch_id
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- Mismo criterio "soft-delete si ya se vendió" que tenía removeProduct.
CREATE OR REPLACE FUNCTION public.remove_product(p_branch_id bigint, p_id bigint)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_in_use bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró el producto % en esta sucursal', p_id;
  END IF;

  SELECT count(*) INTO v_in_use FROM public.sale_items WHERE ref_id = p_id AND item_type = 'product';

  IF v_in_use > 0 THEN
    UPDATE public.products SET active = false WHERE id = p_id AND branch_id = p_branch_id;
    RETURN json_build_object('deleted', false, 'deactivated', true);
  END IF;

  DELETE FROM public.products WHERE id = p_id AND branch_id = p_branch_id;
  RETURN json_build_object('deleted', true, 'deactivated', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_modifier(
  p_branch_id bigint, p_id bigint, p_name text, p_inventory_id bigint, p_price_extra numeric, p_qty_needed numeric DEFAULT NULL
) RETURNS public.modifiers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.modifiers;
BEGIN
  UPDATE public.modifiers
  SET name = COALESCE(p_name, name),
      inventory_id = COALESCE(p_inventory_id, inventory_id),
      price_extra = p_price_extra,
      qty_needed = COALESCE(p_qty_needed, qty_needed)
  WHERE id = p_id AND branch_id = p_branch_id
  RETURNING * INTO v_row;
  IF v_row IS NULL THEN RAISE EXCEPTION 'No se encontró el modificador % en esta sucursal', p_id; END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_products_by_branch(bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.create_product(bigint, text, text, numeric, numeric, boolean, integer, numeric) TO anon;
GRANT EXECUTE ON FUNCTION public.update_product(bigint, bigint, text, text, numeric, numeric, boolean, integer, numeric) TO anon;
GRANT EXECUTE ON FUNCTION public.adjust_product_stock(bigint, bigint, numeric) TO anon;
GRANT EXECUTE ON FUNCTION public.remove_product(bigint, bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.update_modifier(bigint, bigint, text, bigint, numeric, numeric) TO anon;
