-- Auditoría Catálogo 2026-08-21: create_product/update_product
-- (20260820000012_catalog_admin_rpcs.sql) y create_promotion/update_promotion
-- (20260820030000_rpc_branch_id_catalog_ops.sql) hacían COALESCE(p_price, 0)
-- -- NULL se volvía 0, pero nada rechazaba un 0 explícito ni un negativo.
-- catalog-renderer.js validaba solo `!price` (string), que un "0" tecleado
-- literalmente no dispara (es un string no vacío) -- ya corregido ahí a
-- `Number(price) > 0` en la misma sesión. Este archivo cierra el mismo hueco
-- del lado del servidor: las 4 funciones son GRANT a anon, llamables directo
-- por REST con la anon key ya expuesta, mismo patrón que
-- update_kds_status/close_table ya endurecidos antes. Único cambio: exige
-- p_price > 0 explícito (RAISE EXCEPTION si no). Todo lo demás (branch
-- check, resto de columnas) queda igual.
CREATE OR REPLACE FUNCTION public.create_product(
  p_branch_id bigint, p_name text, p_category text, p_price numeric,
  p_employee_price numeric, p_active boolean, p_sort_order integer, p_stock numeric
) RETURNS public.products
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.products;
BEGIN
  IF p_price IS NULL OR p_price <= 0 THEN
    RAISE EXCEPTION 'El precio del producto debe ser mayor a $0.';
  END IF;

  INSERT INTO public.products (name, category, price, employee_price, active, sort_order, stock, branch_id)
  VALUES (p_name, p_category, p_price, p_employee_price, COALESCE(p_active, true), COALESCE(p_sort_order, 0), p_stock, p_branch_id)
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
  IF p_price IS NULL OR p_price <= 0 THEN
    RAISE EXCEPTION 'El precio del producto debe ser mayor a $0.';
  END IF;

  UPDATE public.products
  SET name = p_name, category = p_category, price = p_price, employee_price = p_employee_price,
      active = COALESCE(p_active, true), sort_order = COALESCE(p_sort_order, 0), stock = p_stock
  WHERE id = p_id AND branch_id = p_branch_id
  RETURNING * INTO v_row;
  IF v_row IS NULL THEN RAISE EXCEPTION 'No se encontró el producto % en esta sucursal', p_id; END IF;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_promotion(
  p_branch_id bigint,
  p_name text,
  p_description text,
  p_price numeric,
  p_active boolean,
  p_applicable_category text
) RETURNS public.promotions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.promotions;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch_id) THEN
    RAISE EXCEPTION 'La sucursal % no existe.', p_branch_id;
  END IF;

  IF p_price IS NULL OR p_price <= 0 THEN
    RAISE EXCEPTION 'El precio de la promoción debe ser mayor a $0.';
  END IF;

  INSERT INTO public.promotions (name, description, price, active, applicable_category, branch_id)
  VALUES (p_name, COALESCE(p_description, ''), p_price, COALESCE(p_active, true), p_applicable_category, p_branch_id)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_promotion(
  p_branch_id bigint,
  p_id bigint,
  p_name text,
  p_description text,
  p_price numeric,
  p_active boolean,
  p_applicable_category text
) RETURNS public.promotions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.promotions;
BEGIN
  IF p_price IS NULL OR p_price <= 0 THEN
    RAISE EXCEPTION 'El precio de la promoción debe ser mayor a $0.';
  END IF;

  UPDATE public.promotions
  SET name = p_name,
      description = COALESCE(p_description, ''),
      price = p_price,
      active = COALESCE(p_active, true),
      applicable_category = p_applicable_category
  WHERE id = p_id AND branch_id = p_branch_id
  RETURNING * INTO v_row;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'No se encontró la promoción % en esta sucursal', p_id;
  END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_product(bigint, text, text, numeric, numeric, boolean, integer, numeric) TO anon;
GRANT EXECUTE ON FUNCTION public.update_product(bigint, bigint, text, text, numeric, numeric, boolean, integer, numeric) TO anon;
GRANT EXECUTE ON FUNCTION public.create_promotion(bigint, text, text, numeric, boolean, text) TO anon;
GRANT EXECUTE ON FUNCTION public.update_promotion(bigint, bigint, text, text, numeric, boolean, text) TO anon;
