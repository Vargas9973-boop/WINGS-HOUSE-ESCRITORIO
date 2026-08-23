-- Auditoría de Catálogo/Inventario 2026-08-23: update_modifier valida que el
-- modificador (p_id) sea de p_branch_id, pero nunca valida que p_inventory_id
-- también lo sea -- a diferencia de set_recipes_for_product/
-- set_components_for_product, que sí exigen (`NOT EXISTS ... AND branch_id =
-- p_branch_id`) que cualquier fila enlazada pertenezca a la misma sucursal.
-- catalog-renderer.js:112 arma el <select> solo con
-- window.db.inventory.getAll() (ya branch-scoped), así que la UI nunca deja
-- elegir un insumo de otra sucursal -- pero la RPC en sí (GRANT a
-- authenticated) no lo impide si se llama directo por REST. Efecto real: un
-- modificador de la Sucursal A podría apuntar a un insumo de la Sucursal B
-- (o de otro tenant, porque inventory.id es único global) y
-- sale_item_modifiers_apply_inventory (el trigger que descuenta stock al
-- vender) drenaría en silencio el inventario de ese otro negocio en cada
-- venta que use ese modificador -- mismo patrón de "seguro por construcción
-- de la UI pero no por la RPC" que clone_catalog_to_branch, mismo fix.

CREATE OR REPLACE FUNCTION public.update_modifier(p_branch_id bigint, p_id bigint, p_name text, p_inventory_id bigint, p_price_extra numeric, p_qty_needed numeric DEFAULT NULL::numeric)
 RETURNS modifiers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row public.modifiers;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF p_inventory_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.inventory WHERE id = p_inventory_id AND branch_id = p_branch_id
  ) THEN
    RAISE EXCEPTION 'El insumo % no pertenece a esta sucursal', p_inventory_id;
  END IF;

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
$function$;
