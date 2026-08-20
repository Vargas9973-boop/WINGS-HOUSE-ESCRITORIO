-- El trigger de descuento de salsas (trg_sale_item_modifiers_after_insert,
-- 20260819090000) descontaba un "60" fijo sin unidad -- si el inventario de
-- una salsa está en piezas (unit='pz', "100 piezas") pero en realidad se
-- sirve por peso (60g por orden), el número que baja no significa nada: da
-- igual si hay 5kg o 5 piezas, siempre baja "60".
--
-- Esta app ya resuelve exactamente este problema para recetas de productos
-- (recipes.quantity_needed, "siempre en la unidad propia del insumo, nunca
-- se convierte" -- ver catalog-renderer.js): la solución aquí es la misma
-- idea aplicada a modifiers, NO una tabla/vista nueva. No se agrega
-- unit_type ni una vista de solo-lectura -- inventory.unit ya existe desde
-- 20260817040000 (texto libre: 'pz', 'kg', 'g', 'ml'...) y ya lo edita el
-- admin de Inventario; "porciones restantes" se calcula en el cliente
-- (stock / qty_needed), igual que ya hace el semáforo de disponibilidad de
-- recetas, sin necesitar una vista SQL para eso.

-- ==========================================================================
-- 1. MODIFIERS: cuánto de su insumo consume una porción (en la unidad
--    propia de ese insumo -- si el insumo está en 'g', esto es gramos; si
--    algún día un modificador se sirve por pieza, es piezas)
-- ==========================================================================
ALTER TABLE public.modifiers
  ADD COLUMN IF NOT EXISTS qty_needed numeric NOT NULL DEFAULT 60;

ALTER TABLE public.modifiers
  DROP CONSTRAINT IF EXISTS modifiers_qty_needed_check;
ALTER TABLE public.modifiers
  ADD CONSTRAINT modifiers_qty_needed_check CHECK (qty_needed > 0);

-- Corrige la etiqueta de unidad de las salsas que hoy quedaron en 'pz' (el
-- default de toda fila de inventory) sin tocar su `stock` -- ese número lo
-- debe corregir el admin a mano desde Inventario (pesar/ajustar la
-- existencia real), esta migración no puede adivinar cuántos gramos hay.
UPDATE public.inventory
SET unit = 'g'
WHERE id IN (SELECT inventory_id FROM public.modifiers WHERE group_name = 'Salsas' AND inventory_id IS NOT NULL)
  AND (unit IS NULL OR unit = 'pz');

-- ==========================================================================
-- 2. DESCUENTO: usa modifiers.qty_needed en vez del "60" fijo. Mismo
--    trigger/función ya existente (AFTER INSERT ON sale_item_modifiers) --
--    solo se reemplaza el cuerpo, no se duplica con otro nombre.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.sale_item_modifiers_apply_inventory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_inventory_id bigint;
  v_qty_needed numeric;
  v_qty numeric;
  v_amount numeric;
BEGIN
  SELECT inventory_id, COALESCE(qty_needed, 60) INTO v_inventory_id, v_qty_needed
  FROM public.modifiers WHERE id = NEW.modifier_id;

  IF v_inventory_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT quantity INTO v_qty FROM public.sale_items WHERE id = NEW.sale_item_id;
  IF v_qty IS NULL THEN
    v_qty := 1;
  END IF;

  v_amount := v_qty_needed * v_qty;

  UPDATE public.inventory
  SET stock = GREATEST(stock - v_amount, 0),
      updated_at = now()
  WHERE id = v_inventory_id;

  INSERT INTO public.inventory_movements (insumo_id, type, quantity, reason)
  VALUES (v_inventory_id, 'venta', v_amount, 'Venta - salsa elegida');

  RETURN NEW;
END;
$function$;

-- ==========================================================================
-- 3. REPOSICIÓN: si se quita el artículo de una comanda abierta antes de
--    cobrar (comanda_remove_item hace DELETE FROM sale_items, que cascada a
--    sale_item_modifiers), repone la misma cantidad que se había
--    descontado. No existía esta mitad -- solo estaba el INSERT.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.sale_item_modifiers_replenish_inventory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_inventory_id bigint;
  v_qty_needed numeric;
  v_qty numeric;
  v_amount numeric;
BEGIN
  SELECT inventory_id, COALESCE(qty_needed, 60) INTO v_inventory_id, v_qty_needed
  FROM public.modifiers WHERE id = OLD.modifier_id;

  IF v_inventory_id IS NULL THEN
    RETURN OLD;
  END IF;

  -- El sale_item ya no existe si esto se disparó por el cascade de borrar
  -- el renglón completo (caso normal: comanda_remove_item) -- se repone la
  -- ración de 1 unidad como mínimo razonable cuando no se puede leer la
  -- cantidad real que tenía.
  SELECT quantity INTO v_qty FROM public.sale_items WHERE id = OLD.sale_item_id;
  IF v_qty IS NULL THEN
    v_qty := 1;
  END IF;

  v_amount := v_qty_needed * v_qty;

  UPDATE public.inventory
  SET stock = GREATEST(stock + v_amount, 0),
      updated_at = now()
  WHERE id = v_inventory_id;

  INSERT INTO public.inventory_movements (insumo_id, type, quantity, reason)
  VALUES (v_inventory_id, 'ajuste', v_amount, 'Reposición - salsa quitada antes de cobrar');

  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sale_item_modifiers_after_delete ON public.sale_item_modifiers;
CREATE TRIGGER trg_sale_item_modifiers_after_delete
AFTER DELETE ON public.sale_item_modifiers
FOR EACH ROW EXECUTE FUNCTION public.sale_item_modifiers_replenish_inventory();
