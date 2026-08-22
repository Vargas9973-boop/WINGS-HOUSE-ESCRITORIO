-- Costos: Food Cost por producto / Margen real / Valuación de inventario
-- (feature nueva, confirmada con el usuario 2026-08-21 -- no existía nada de
-- esto, ver memoria costs-module-audit).
--
-- products no tenía ninguna columna de costo -- solo price. Para productos
-- de receta (stock IS NULL) el costo ya se calcula desde recipes+inventory
-- (get_all_recipe_costs, ya existente); para productos "directos" (stock
-- NOT NULL, ej. refresco embotellado) no hay receta que calcular, así que
-- se agrega esta columna paralela a inventory.cost_per_unit, capturada a
-- mano en Catálogo igual que el costo de un insumo.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS cost_per_unit numeric;

-- create_product/update_product: se les agrega p_cost_per_unit al final con
-- DEFAULT NULL (no cambia el orden/tipo de los parámetros existentes, así
-- que CREATE OR REPLACE sigue reemplazando in-place sin crear una segunda
-- sobrecarga). La validación price > 0 de 20260821060000_catalog_price_required.sql
-- se conserva igual.
CREATE OR REPLACE FUNCTION public.create_product(
  p_branch_id bigint, p_name text, p_category text, p_price numeric,
  p_employee_price numeric, p_active boolean, p_sort_order integer, p_stock numeric,
  p_cost_per_unit numeric DEFAULT NULL
) RETURNS public.products
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.products;
BEGIN
  IF p_price IS NULL OR p_price <= 0 THEN
    RAISE EXCEPTION 'El precio del producto debe ser mayor a $0.';
  END IF;

  INSERT INTO public.products (name, category, price, employee_price, active, sort_order, stock, cost_per_unit, branch_id)
  VALUES (p_name, p_category, p_price, p_employee_price, COALESCE(p_active, true), COALESCE(p_sort_order, 0), p_stock, p_cost_per_unit, p_branch_id)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_product(
  p_branch_id bigint, p_id bigint, p_name text, p_category text, p_price numeric,
  p_employee_price numeric, p_active boolean, p_sort_order integer, p_stock numeric,
  p_cost_per_unit numeric DEFAULT NULL
) RETURNS public.products
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.products;
BEGIN
  IF p_price IS NULL OR p_price <= 0 THEN
    RAISE EXCEPTION 'El precio del producto debe ser mayor a $0.';
  END IF;

  UPDATE public.products
  SET name = p_name, category = p_category, price = p_price, employee_price = p_employee_price,
      active = COALESCE(p_active, true), sort_order = COALESCE(p_sort_order, 0), stock = p_stock,
      cost_per_unit = p_cost_per_unit
  WHERE id = p_id AND branch_id = p_branch_id
  RETURNING * INTO v_row;
  IF v_row IS NULL THEN RAISE EXCEPTION 'No se encontró el producto % en esta sucursal', p_id; END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_product(bigint, text, text, numeric, numeric, boolean, integer, numeric, numeric) TO anon;
GRANT EXECUTE ON FUNCTION public.update_product(bigint, bigint, text, text, numeric, numeric, boolean, integer, numeric, numeric) TO anon;

-- get_sale_items_summary (20260820025000_close_sale_items_reads.sql) solo
-- devolvía name/quantity/subtotal -- suficiente para "top productos", pero
-- no para calcular costo de venta (COGS) por producto, que necesita saber
-- A QUÉ producto corresponde cada renglón. Cambia el RETURNS TABLE, así que
-- requiere DROP antes (CREATE OR REPLACE no puede cambiar la forma del
-- resultado).
DROP FUNCTION IF EXISTS public.get_sale_items_summary(bigint, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.get_sale_items_summary(p_branch_id bigint, p_from timestamptz, p_to timestamptz)
RETURNS TABLE(ref_id sale_items.ref_id%TYPE, item_type sale_items.item_type%TYPE, name sale_items.name%TYPE, quantity sale_items.quantity%TYPE, subtotal sale_items.subtotal%TYPE)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT si.ref_id, si.item_type, si.name, si.quantity, si.subtotal
  FROM public.sale_items si
  JOIN public.sales s ON s.id = si.sale_id
  WHERE s.branch_id = p_branch_id
    AND s.status = 'completada'
    AND s.created_at >= p_from
    AND s.created_at <= p_to;
$$;

GRANT EXECUTE ON FUNCTION public.get_sale_items_summary(bigint, timestamptz, timestamptz) TO anon;
