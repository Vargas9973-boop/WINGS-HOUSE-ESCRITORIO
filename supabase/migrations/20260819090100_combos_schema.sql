-- Combos/promos (p.ej. "PROMO 40 ALITAS") que hoy se venden a mano como 3
-- renglones sueltos de ALITAS porque no hay forma de que un solo producto
-- descuente varios insumos/subproductos a la vez.
--
-- DISEÑO -- deliberadamente MÁS SIMPLE que "un combo = tabla nueva con dos
-- FKs opcionales (insumo o producto)": esta app ya tiene [[recipes]]
-- (product_id -> insumo_id, quantity_needed) con su propio trigger de
-- descuento (trg_sale_items_apply_recipe_inventory, 20260817040000) y su
-- propio bloqueo de stock insuficiente (20260818020000). Un combo que
-- necesita "40 piezas de ALITA" no es un caso nuevo: es exactamente un
-- renglón de receta más, con quantity_needed=40 -- reutilizarlo evita
-- duplicar esa lógica (descuento + reposición + bloqueo) para un segundo
-- camino que haría lo mismo.
--
-- Lo único que `recipes` no puede expresar es "este producto incluye 2
-- unidades de OTRO PRODUCTO del catálogo" (p.ej. 2 órdenes de PAPA
-- FRANCESA, que a su vez tiene su propia receta de insumos). Eso es lo que
-- agrega product_components: producto -> producto, con cantidad. Al
-- venderse el combo, su trigger recorre esos componentes y descuenta la
-- receta completa de cada producto componente (multiplicada por su
-- cantidad en el combo y por la cantidad vendida), con el mismo patrón
-- (delta INSERT/UPDATE/DELETE, GREATEST(...,0), log en inventory_movements)
-- que ya usa trg_sale_items_apply_recipe_inventory.
--
-- Las salsas de un combo (p.ej. "2 salsas a elegir") reutilizan
-- [[product_modifier_groups]]/[[sale_item_modifiers]] ya existentes
-- (20260819090000_sauce_modifiers_schema.sql): solo se le agrega una
-- columna `qty` a product_modifier_groups (cuántas salsas hay que elegir,
-- default 1) -- sale_item_modifiers y su trigger de descuento ya soportan
-- N filas por renglón de venta sin cambios.
--
-- Un producto "combo" (PROMO 40 ALITAS) por lo tanto se arma con TRES
-- piezas ya existentes/extendidas, sin tabla redundante:
--   1) recipes            -- insumos directos (40 pzs de ALITA)
--   2) product_components -- subproductos del catálogo (2x PAPA FRANCESA)
--   3) product_modifier_groups.qty -- cuántas salsas elegir (2)

-- ==========================================================================
-- 1. PRODUCT_MODIFIER_GROUPS: cuántas selecciones exige el grupo
-- ==========================================================================
ALTER TABLE public.product_modifier_groups
  ADD COLUMN IF NOT EXISTS qty integer NOT NULL DEFAULT 1;

ALTER TABLE public.product_modifier_groups
  DROP CONSTRAINT IF EXISTS product_modifier_groups_qty_check;
ALTER TABLE public.product_modifier_groups
  ADD CONSTRAINT product_modifier_groups_qty_check CHECK (qty > 0);

-- ==========================================================================
-- 2. PRODUCT_COMPONENTS: producto -> producto (subproductos de un combo)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.product_components (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_product_id bigint NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  component_product_id bigint NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  qty numeric NOT NULL CHECK (qty > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (component_product_id <> parent_product_id),
  UNIQUE (parent_product_id, component_product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_components_parent ON public.product_components (parent_product_id);
CREATE INDEX IF NOT EXISTS idx_product_components_component ON public.product_components (component_product_id);

ALTER TABLE public.product_components ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_anon_all" ON public.product_components;
CREATE POLICY "allow_anon_all" ON public.product_components FOR ALL TO anon USING (true) WITH CHECK (true);
GRANT ALL ON public.product_components TO anon, authenticated;

-- ==========================================================================
-- 3. DESCUENTO AUTOMÁTICO DE INVENTARIO POR SUBPRODUCTOS DEL COMBO
-- ==========================================================================
-- Mismo patrón/comentarios que sale_items_apply_recipe_inventory
-- (20260817040000): INSERT descuenta, DELETE repone, UPDATE aplica solo el
-- delta (o repone completo + descuenta completo si cambió el producto). El
-- stock nunca baja de 0 (GREATEST) -- no bloquea la venta, la app avisa del
-- lado del cliente.
CREATE OR REPLACE FUNCTION public.sale_items_apply_combo_inventory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_delta numeric;
  v_ref_id bigint;
  v_item_type text;
  v_comp record;
  v_rec record;
  v_move_type text;
  v_reason text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_delta := NEW.quantity;
    v_ref_id := NEW.ref_id;
    v_item_type := COALESCE(NEW.item_type, 'product');
    v_move_type := 'venta';
    v_reason := 'Venta - combo agregado';

  ELSIF TG_OP = 'DELETE' THEN
    v_delta := -OLD.quantity;
    v_ref_id := OLD.ref_id;
    v_item_type := COALESCE(OLD.item_type, 'product');
    v_move_type := 'ajuste';
    v_reason := 'Reposición - combo eliminado antes de cobrar';

  ELSE -- UPDATE
    IF COALESCE(NEW.ref_id, -1) IS DISTINCT FROM COALESCE(OLD.ref_id, -1)
       OR COALESCE(NEW.item_type, 'product') IS DISTINCT FROM COALESCE(OLD.item_type, 'product')
    THEN
      IF COALESCE(OLD.item_type, 'product') = 'product' AND OLD.ref_id IS NOT NULL THEN
        FOR v_comp IN
          SELECT component_product_id, qty FROM public.product_components WHERE parent_product_id = OLD.ref_id
        LOOP
          FOR v_rec IN
            SELECT insumo_id, quantity_needed FROM public.recipes WHERE product_id = v_comp.component_product_id
          LOOP
            UPDATE public.inventory
            SET stock = GREATEST(stock + v_rec.quantity_needed * v_comp.qty * OLD.quantity, 0),
                updated_at = now()
            WHERE id = v_rec.insumo_id;

            INSERT INTO public.inventory_movements (insumo_id, type, quantity, reason)
            VALUES (v_rec.insumo_id, 'ajuste', v_rec.quantity_needed * v_comp.qty * OLD.quantity, 'Reposición - se cambió el artículo en la venta (combo)');
          END LOOP;
        END LOOP;
      END IF;

      v_delta := NEW.quantity;
      v_ref_id := NEW.ref_id;
      v_item_type := COALESCE(NEW.item_type, 'product');
      v_move_type := 'venta';
      v_reason := 'Venta - combo actualizado';
    ELSE
      v_delta := NEW.quantity - OLD.quantity;
      v_ref_id := NEW.ref_id;
      v_item_type := COALESCE(NEW.item_type, 'product');
      v_move_type := 'ajuste';
      v_reason := 'Ajuste de cantidad en venta (combo)';
    END IF;
  END IF;

  IF v_item_type = 'product' AND v_ref_id IS NOT NULL AND v_delta <> 0 THEN
    FOR v_comp IN
      SELECT component_product_id, qty FROM public.product_components WHERE parent_product_id = v_ref_id
    LOOP
      FOR v_rec IN
        SELECT insumo_id, quantity_needed FROM public.recipes WHERE product_id = v_comp.component_product_id
      LOOP
        UPDATE public.inventory
        SET stock = GREATEST(stock - v_rec.quantity_needed * v_comp.qty * v_delta, 0),
            updated_at = now()
        WHERE id = v_rec.insumo_id;

        INSERT INTO public.inventory_movements (insumo_id, type, quantity, reason)
        VALUES (v_rec.insumo_id, v_move_type, v_rec.quantity_needed * v_comp.qty * v_delta, v_reason);
      END LOOP;
    END LOOP;
  END IF;

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sale_items_apply_combo_inventory ON public.sale_items;
CREATE TRIGGER trg_sale_items_apply_combo_inventory
AFTER INSERT OR UPDATE OR DELETE ON public.sale_items
FOR EACH ROW EXECUTE FUNCTION public.sale_items_apply_combo_inventory();
