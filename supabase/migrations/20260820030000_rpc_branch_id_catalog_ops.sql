-- Opción A -- Tarea 2 / Migración 0009 (parte 1, continuación): RPC nuevos
-- para promotions e inventory -- ambas tablas ya tenían branch_id correcto
-- en sus valores (createPromotion/createInventoryItem ya lo seteaban bien
-- en db.js), pero las escrituras eran directas (.insert/.update/.delete),
-- así que quedan bloqueadas por 20260820010000 hasta tener estos RPC.
-- Traducción mecánica de la lógica ya existente en db.js -- sin cambios de
-- comportamiento.

-- ============================================================
-- PROMOTIONS
-- ============================================================
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

  INSERT INTO public.promotions (name, description, price, active, applicable_category, branch_id)
  VALUES (p_name, COALESCE(p_description, ''), COALESCE(p_price, 0), COALESCE(p_active, true), p_applicable_category, p_branch_id)
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
  UPDATE public.promotions
  SET name = p_name,
      description = COALESCE(p_description, ''),
      price = COALESCE(p_price, 0),
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

CREATE OR REPLACE FUNCTION public.remove_promotion(p_branch_id bigint, p_id bigint)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_in_use bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.promotions WHERE id = p_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró la promoción % en esta sucursal', p_id;
  END IF;

  SELECT count(*) INTO v_in_use FROM public.sale_items WHERE ref_id = p_id AND item_type = 'promo';

  IF v_in_use > 0 THEN
    UPDATE public.promotions SET active = false WHERE id = p_id AND branch_id = p_branch_id;
    RETURN json_build_object('deleted', false, 'deactivated', true);
  END IF;

  DELETE FROM public.promotions WHERE id = p_id AND branch_id = p_branch_id;
  RETURN json_build_object('deleted', true, 'deactivated', false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_promotion(bigint, text, text, numeric, boolean, text) TO anon;
GRANT EXECUTE ON FUNCTION public.update_promotion(bigint, bigint, text, text, numeric, boolean, text) TO anon;
GRANT EXECUTE ON FUNCTION public.remove_promotion(bigint, bigint) TO anon;

-- ============================================================
-- INVENTORY
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_inventory_item(
  p_branch_id bigint,
  p_name text,
  p_category text,
  p_unit text,
  p_stock numeric,
  p_min_stock numeric,
  p_cost_per_unit numeric,
  p_created_by text
) RETURNS public.inventory
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.inventory;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'El nombre del insumo es obligatorio.';
  END IF;
  IF COALESCE(p_stock, 0) < 0 THEN
    RAISE EXCEPTION 'La existencia inicial no puede ser negativa.';
  END IF;

  BEGIN
    INSERT INTO public.inventory (name, category, unit, stock, min_stock, cost_per_unit, branch_id)
    VALUES (btrim(p_name), p_category, COALESCE(p_unit, 'pz'), COALESCE(p_stock, 0), COALESCE(p_min_stock, 0), COALESCE(p_cost_per_unit, 0), p_branch_id)
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Ya existe un insumo llamado "%".', p_name;
  END;

  IF COALESCE(p_stock, 0) > 0 THEN
    INSERT INTO public.inventory_movements (insumo_id, type, quantity, reason, created_by)
    VALUES (v_row.id, 'entrada', p_stock, 'Alta de insumo - existencia inicial', p_created_by);
  END IF;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_inventory_item(
  p_branch_id bigint,
  p_id bigint,
  p_name text,
  p_category text,
  p_unit text,
  p_stock numeric,
  p_min_stock numeric,
  p_cost_per_unit numeric,
  p_created_by text
) RETURNS public.inventory
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before public.inventory;
  v_row public.inventory;
  v_delta numeric;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'El nombre del insumo es obligatorio.';
  END IF;
  IF COALESCE(p_stock, 0) < 0 THEN
    RAISE EXCEPTION 'La existencia no puede ser negativa.';
  END IF;

  SELECT * INTO v_before FROM public.inventory WHERE id = p_id AND branch_id = p_branch_id;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'No se encontró el insumo % en esta sucursal', p_id;
  END IF;

  BEGIN
    UPDATE public.inventory
    SET name = btrim(p_name), category = p_category, unit = COALESCE(p_unit, 'pz'),
        stock = COALESCE(p_stock, 0), min_stock = COALESCE(p_min_stock, 0),
        cost_per_unit = COALESCE(p_cost_per_unit, 0), updated_at = now()
    WHERE id = p_id AND branch_id = p_branch_id
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Ya existe un insumo llamado "%".', p_name;
  END;

  v_delta := COALESCE(p_stock, 0) - COALESCE(v_before.stock, 0);
  IF v_delta <> 0 THEN
    INSERT INTO public.inventory_movements (insumo_id, type, quantity, reason, created_by)
    VALUES (p_id, 'ajuste', v_delta, 'Ajuste manual desde edición de insumo', p_created_by);
  END IF;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_inventory_item(p_branch_id bigint, p_id bigint)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.inventory WHERE id = p_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró el insumo % en esta sucursal', p_id;
  END IF;

  UPDATE public.waste SET inventory_id = NULL WHERE inventory_id = p_id;
  DELETE FROM public.inventory WHERE id = p_id AND branch_id = p_branch_id;
  RETURN json_build_object('deleted', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.add_inventory_stock(
  p_branch_id bigint,
  p_id bigint,
  p_quantity numeric,
  p_cost_per_unit numeric,
  p_reason text,
  p_created_by text
) RETURNS public.inventory
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item public.inventory;
  v_row public.inventory;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'La cantidad a agregar debe ser mayor que cero.';
  END IF;

  SELECT * INTO v_item FROM public.inventory WHERE id = p_id AND branch_id = p_branch_id;
  IF v_item IS NULL THEN
    RAISE EXCEPTION 'No se encontró el insumo % en esta sucursal', p_id;
  END IF;

  UPDATE public.inventory
  SET stock = COALESCE(stock, 0) + p_quantity,
      cost_per_unit = CASE WHEN p_cost_per_unit IS NOT NULL THEN p_cost_per_unit ELSE cost_per_unit END,
      updated_at = now()
  WHERE id = p_id AND branch_id = p_branch_id
  RETURNING * INTO v_row;

  INSERT INTO public.inventory_movements (insumo_id, type, quantity, reason, created_by)
  VALUES (p_id, 'entrada', p_quantity, COALESCE(p_reason, 'Compra'), p_created_by);

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_inventory_item(bigint, text, text, text, numeric, numeric, numeric, text) TO anon;
GRANT EXECUTE ON FUNCTION public.update_inventory_item(bigint, bigint, text, text, text, numeric, numeric, numeric, text) TO anon;
GRANT EXECUTE ON FUNCTION public.remove_inventory_item(bigint, bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.add_inventory_stock(bigint, bigint, numeric, numeric, text, text) TO anon;
