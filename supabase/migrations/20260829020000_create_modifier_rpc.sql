-- Bug reportado 2026-08-29: en un tenant nuevo, dar de alta ALITAS/BONELESS
-- con su receta y activar el grupo "Salsas" (product_modifier_groups) deja
-- el selector de salsa de Ventas vacío -- solo se ven los botones Cancelar/
-- Agregar, sin ninguna salsa para elegir (showSauceSelector en
-- sales-renderer.js sí abre el modal porque el grupo existe, pero
-- getModifiers()/get_modifiers_by_branch no devuelve filas porque `modifiers`
-- es una tabla por sucursal -- 20260820080000_catalog_by_branch.sql -- y
-- nunca se siembra para una sucursal nueva (scripts/onboard-tenant.js NO
-- crea productos/categorías/modifiers, y clone_catalog_to_branch no tiene
-- ningún caller real hoy, ver 20260823140000).
--
-- En el tenant original esto "funciona" solo porque esa sucursal ya tenía
-- las 9 salsas cargadas a mano desde antes de que el catálogo fuera
-- multi-tenant (20260819090000_sauce_modifiers_schema.sql). No es un bug de
-- lógica: es que jamás existió una forma de crear un modificador nuevo --
-- ni RPC (update_modifier existe desde 20260820000012, pero solo actualiza
-- una fila que ya existe) ni botón en catalog-renderer.js (renderModifiers
-- solo pinta <select>/<input> de edición para modifiers ya cargados).
--
-- Fix: agrega create_modifier, mismo patrón de guard que create_product/
-- update_modifier (branch_id validado contra current_branch_id(), y el
-- insumo vinculado -- si se manda -- validado contra esa misma sucursal,
-- igual que 20260823150000 ya exige en update_modifier).

CREATE OR REPLACE FUNCTION public.create_modifier(
  p_branch_id bigint, p_name text, p_group_name text, p_inventory_id bigint,
  p_price_extra numeric, p_qty_needed numeric DEFAULT NULL::numeric
) RETURNS public.modifiers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.modifiers;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'El nombre del modificador es obligatorio';
  END IF;

  IF p_group_name IS NULL OR btrim(p_group_name) = '' THEN
    RAISE EXCEPTION 'El grupo del modificador es obligatorio';
  END IF;

  IF p_inventory_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.inventory WHERE id = p_inventory_id AND branch_id = p_branch_id
  ) THEN
    RAISE EXCEPTION 'El insumo % no pertenece a esta sucursal', p_inventory_id;
  END IF;

  INSERT INTO public.modifiers (name, group_name, inventory_id, price_extra, qty_needed, is_required, is_active, active, branch_id)
  VALUES (btrim(p_name), btrim(p_group_name), p_inventory_id, p_price_extra, COALESCE(p_qty_needed, 60), false, true, true, p_branch_id)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_modifier(bigint, text, text, bigint, numeric, numeric) TO anon;
