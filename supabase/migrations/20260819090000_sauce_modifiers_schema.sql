-- Documenta en migraciones el esquema de "modificadores" (salsas de
-- ALITAS/BONELESS) que ya existe en la base remota pero que hasta ahora
-- solo vivía ahí -- no había ninguna migración local que lo creara, así que
-- un entorno nuevo (`supabase db reset` / otra sucursal) se quedaría sin
-- estas tablas aunque el código (db.js/main.js/preload.js/
-- comandas-renderer.js/catalog-renderer.js) ya las usa en producción.
-- Todo con IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS para
-- que correr esta migración contra la base remota (donde las tablas ya
-- existen con datos) sea un no-op seguro.
--
-- 1) modifiers            -- catálogo de modificadores (hoy: 9 salsas,
--                             group_name='Salsas'), cada uno ligado a su
--                             insumo de inventario para poder descontar
--                             stock al venderse.
-- 2) product_modifier_groups -- qué productos exigen elegir de qué grupo
--                             (hoy: ALITAS y BONELESS -> 'Salsas').
-- 3) sale_item_modifiers   -- la salsa elegida en cada renglón de venta
--                             (sale_items) ya facturado.
-- 4) trigger AFTER INSERT en sale_item_modifiers que descuenta
--    60 * cantidad del insumo ligado a la salsa elegida (ver
--    comandaAddItemWithModifiers en db.js) -- mismo patrón que
--    trg_sale_items_apply_recipe_inventory (20260817040000) pero solo para
--    el camino de alta: el flujo actual de la app no permite cambiar la
--    salsa de un renglón ya creado, solo agregarlo o borrar la mesa/venta
--    completa.

-- ==========================================================================
-- 1. MODIFIERS
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.modifiers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  group_name text NOT NULL,
  inventory_id bigint REFERENCES public.inventory(id) ON DELETE SET NULL,
  price_extra numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_modifiers_group_name ON public.modifiers (group_name);

ALTER TABLE public.modifiers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_anon_all" ON public.modifiers;
CREATE POLICY "allow_anon_all" ON public.modifiers FOR ALL TO anon USING (true) WITH CHECK (true);
GRANT ALL ON public.modifiers TO anon, authenticated;

-- ==========================================================================
-- 2. PRODUCT_MODIFIER_GROUPS
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.product_modifier_groups (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id bigint NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  group_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, group_name)
);

CREATE INDEX IF NOT EXISTS idx_product_modifier_groups_product ON public.product_modifier_groups (product_id);

ALTER TABLE public.product_modifier_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_anon_all" ON public.product_modifier_groups;
CREATE POLICY "allow_anon_all" ON public.product_modifier_groups FOR ALL TO anon USING (true) WITH CHECK (true);
GRANT ALL ON public.product_modifier_groups TO anon, authenticated;

-- ==========================================================================
-- 3. SALE_ITEM_MODIFIERS
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.sale_item_modifiers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sale_item_id bigint NOT NULL REFERENCES public.sale_items(id) ON DELETE CASCADE,
  modifier_id bigint NOT NULL REFERENCES public.modifiers(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sale_item_modifiers_sale_item ON public.sale_item_modifiers (sale_item_id);
CREATE INDEX IF NOT EXISTS idx_sale_item_modifiers_modifier ON public.sale_item_modifiers (modifier_id);

ALTER TABLE public.sale_item_modifiers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_anon_all" ON public.sale_item_modifiers;
CREATE POLICY "allow_anon_all" ON public.sale_item_modifiers FOR ALL TO anon USING (true) WITH CHECK (true);
GRANT ALL ON public.sale_item_modifiers TO anon, authenticated;

-- ==========================================================================
-- 4. DESCUENTO AUTOMÁTICO DE INVENTARIO POR SALSA ELEGIDA
-- ==========================================================================
-- El stock nunca baja de 0 (GREATEST), igual que el trigger de recetas: la
-- app avisa stock bajo/insuficiente del lado del cliente, este trigger solo
-- registra el consumo real.
CREATE OR REPLACE FUNCTION public.sale_item_modifiers_apply_inventory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_inventory_id bigint;
  v_qty numeric;
  v_amount numeric;
BEGIN
  SELECT inventory_id INTO v_inventory_id FROM public.modifiers WHERE id = NEW.modifier_id;
  IF v_inventory_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT quantity INTO v_qty FROM public.sale_items WHERE id = NEW.sale_item_id;
  v_amount := 60 * COALESCE(v_qty, 1);

  UPDATE public.inventory
  SET stock = GREATEST(stock - v_amount, 0),
      updated_at = now()
  WHERE id = v_inventory_id;

  INSERT INTO public.inventory_movements (insumo_id, type, quantity, reason)
  VALUES (v_inventory_id, 'venta', v_amount, 'Venta - salsa elegida');

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sale_item_modifiers_after_insert ON public.sale_item_modifiers;
CREATE TRIGGER trg_sale_item_modifiers_after_insert
AFTER INSERT ON public.sale_item_modifiers
FOR EACH ROW EXECUTE FUNCTION public.sale_item_modifiers_apply_inventory();
