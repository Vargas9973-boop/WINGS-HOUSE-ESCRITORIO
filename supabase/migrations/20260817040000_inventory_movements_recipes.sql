-- Módulo de inventario estaba a medias: la tabla inventory ya existía
-- (name, unit, stock, min_stock, cost_per_unit, branch_id) y ya se usaba
-- desde waste-renderer.js/db.js, pero:
--   1) No tenía categoría.
--   2) No había bitácora de movimientos (entradas/salidas/mermas/ventas).
--   3) No había forma de ligar un producto del catálogo con los insumos que
--      consume (recetas), así que una venta nunca descontaba insumos.
-- Esta migración completa el esquema sin tocar las columnas ya usadas por
-- código existente (createInventoryItem/updateInventoryItem/createWaste en
-- db.js siguen leyendo/escribiendo `stock`, no se renombra a `quantity`).

-- ==========================================================================
-- 1. INVENTORY: agrega categoría y created_at si faltan
-- ==========================================================================
ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- Nombre único por sucursal (evita altas duplicadas del mismo insumo).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_name_branch_unique'
  ) THEN
    ALTER TABLE public.inventory
      ADD CONSTRAINT inventory_name_branch_unique UNIQUE (name, branch_id);
  END IF;
END $$;

-- ==========================================================================
-- 2. INVENTORY_MOVEMENTS: bitácora de cada entrada/salida de insumo
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.inventory_movements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  insumo_id bigint NOT NULL REFERENCES public.inventory(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('entrada', 'salida', 'ajuste', 'merma', 'venta')),
  quantity numeric NOT NULL,
  reason text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_insumo
  ON public.inventory_movements (insumo_id, created_at DESC);

ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_anon_all" ON public.inventory_movements;
CREATE POLICY "allow_anon_all" ON public.inventory_movements FOR ALL TO anon USING (true) WITH CHECK (true);
GRANT ALL ON public.inventory_movements TO anon, authenticated;

-- ==========================================================================
-- 3. RECIPES: cuánto insumo consume cada producto del catálogo por venta
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.recipes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id bigint NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  insumo_id bigint NOT NULL REFERENCES public.inventory(id) ON DELETE CASCADE,
  quantity_needed numeric NOT NULL CHECK (quantity_needed > 0),
  UNIQUE (product_id, insumo_id)
);

CREATE INDEX IF NOT EXISTS idx_recipes_product ON public.recipes (product_id);
CREATE INDEX IF NOT EXISTS idx_recipes_insumo ON public.recipes (insumo_id);

ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_anon_all" ON public.recipes;
CREATE POLICY "allow_anon_all" ON public.recipes FOR ALL TO anon USING (true) WITH CHECK (true);
GRANT ALL ON public.recipes TO anon, authenticated;

-- ==========================================================================
-- 4. DESCUENTO AUTOMÁTICO DE INVENTARIO POR VENTA
-- ==========================================================================
-- En vez de tocar process_sale() (863 líneas, ya frágil y editada muchas
-- veces) o comanda_add_item/comanda_update_item_qty/comanda_remove_item,
-- se usa un trigger sobre sale_items: cualquier alta/edición/baja de un
-- artículo de venta (mesa abierta o venta directa) pasa siempre por INSERT/
-- UPDATE/DELETE en esa tabla, así que el trigger cubre los 3 caminos sin
-- riesgo de romper esas funciones.
--   INSERT  -> descuenta receta completa (cantidad vendida).
--   DELETE  -> repone receta completa (se quitó el artículo antes de cobrar).
--   UPDATE  -> descuenta/repone solo el delta de cantidad; si cambió el
--              producto (ref_id/item_type), primero repone la receta vieja
--              completa y luego descuenta la receta nueva completa.
-- El stock nunca baja de 0 (GREATEST), así que nunca bloquea la venta; la
-- app avisa "stock bajo/insuficiente" del lado del cliente (toast) leyendo
-- inventory.stock vs. min_stock después de la venta.
CREATE OR REPLACE FUNCTION public.sale_items_apply_recipe_inventory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_delta numeric;
  v_ref_id bigint;
  v_item_type text;
  v_rec record;
  v_move_type text;
  v_reason text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_delta := NEW.quantity;
    v_ref_id := NEW.ref_id;
    v_item_type := COALESCE(NEW.item_type, 'product');
    v_move_type := 'venta';
    v_reason := 'Venta - artículo agregado';

  ELSIF TG_OP = 'DELETE' THEN
    v_delta := -OLD.quantity;
    v_ref_id := OLD.ref_id;
    v_item_type := COALESCE(OLD.item_type, 'product');
    v_move_type := 'ajuste';
    v_reason := 'Reposición - artículo eliminado antes de cobrar';

  ELSE -- UPDATE
    IF COALESCE(NEW.ref_id, -1) IS DISTINCT FROM COALESCE(OLD.ref_id, -1)
       OR COALESCE(NEW.item_type, 'product') IS DISTINCT FROM COALESCE(OLD.item_type, 'product')
    THEN
      -- Cambió el artículo: repone la receta vieja completa primero.
      IF COALESCE(OLD.item_type, 'product') = 'product' AND OLD.ref_id IS NOT NULL THEN
        FOR v_rec IN
          SELECT insumo_id, quantity_needed FROM public.recipes WHERE product_id = OLD.ref_id
        LOOP
          UPDATE public.inventory
          SET stock = GREATEST(stock + v_rec.quantity_needed * OLD.quantity, 0),
              updated_at = now()
          WHERE id = v_rec.insumo_id;

          INSERT INTO public.inventory_movements (insumo_id, type, quantity, reason)
          VALUES (v_rec.insumo_id, 'ajuste', v_rec.quantity_needed * OLD.quantity, 'Reposición - se cambió el artículo en la venta');
        END LOOP;
      END IF;

      v_delta := NEW.quantity;
      v_ref_id := NEW.ref_id;
      v_item_type := COALESCE(NEW.item_type, 'product');
      v_move_type := 'venta';
      v_reason := 'Venta - artículo actualizado';
    ELSE
      v_delta := NEW.quantity - OLD.quantity;
      v_ref_id := NEW.ref_id;
      v_item_type := COALESCE(NEW.item_type, 'product');
      v_move_type := 'ajuste';
      v_reason := 'Ajuste de cantidad en venta';
    END IF;
  END IF;

  IF v_item_type = 'product' AND v_ref_id IS NOT NULL AND v_delta <> 0 THEN
    FOR v_rec IN
      SELECT insumo_id, quantity_needed FROM public.recipes WHERE product_id = v_ref_id
    LOOP
      UPDATE public.inventory
      SET stock = GREATEST(stock - v_rec.quantity_needed * v_delta, 0),
          updated_at = now()
      WHERE id = v_rec.insumo_id;

      INSERT INTO public.inventory_movements (insumo_id, type, quantity, reason)
      VALUES (v_rec.insumo_id, v_move_type, v_rec.quantity_needed * v_delta, v_reason);
    END LOOP;
  END IF;

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sale_items_apply_recipe_inventory ON public.sale_items;
CREATE TRIGGER trg_sale_items_apply_recipe_inventory
AFTER INSERT OR UPDATE OR DELETE ON public.sale_items
FOR EACH ROW EXECUTE FUNCTION public.sale_items_apply_recipe_inventory();
