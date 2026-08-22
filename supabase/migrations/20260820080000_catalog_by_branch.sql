-- Opción A -- decisión de catálogo: POR SUCURSAL, no compartido.
-- Migración 0011. Corrige el borrador original contra el schema real:
--   - "modifier_groups" y "product_modifiers" no existen como tablas --
--     la real es product_modifier_groups (product_id, group_name, qty),
--     sin ninguna referencia directa a modifiers.id. No necesita su propia
--     columna branch_id: ya queda acotada por product_id (que sí la
--     tendrá). Mismo razonamiento para product_components (combos) y
--     recipes (insumos por producto) -- ver notas en cada sección.
--   - promotions YA TIENE branch_id desde 20260815070000_branch_and_ticket_schema.sql
--     (confirmado: getAllPromotions/createPromotion ya lo usan). El ALTER
--     de abajo es un no-op seguro (IF NOT EXISTS) por si acaso, no un
--     error por repetirlo.
--   - settings queda FUERA de esta migración: no está definida en ningún
--     archivo de este repo (como products/branches originalmente, se creó
--     a mano en el dashboard) y set_setting() es un RPC "caja negra" del
--     que no tengo el cuerpo -- agregarle branch_id a ciegas puede chocar
--     con una UNIQUE(key) que no sé si existe. Ver la consulta de
--     introspección al final de este archivo.
--
-- products y modifiers quedan con el MISMO candado "FOR ALL ... USING
-- (false)" que pediste -- a diferencia de 0008, aquí SÍ se bloquea SELECT
-- también, porque el catálogo es chico (a diferencia de sales/reportes) y
-- se puede cubrir completo con un puñado de RPC de lectura sin reescribir
-- lógica de negocio (son selects planos, no agregaciones como
-- getPayrollData/computeProfitability).

-- ==========================================================================
-- 1. COLUMNAS + BACKFILL + NOT NULL + ÍNDICES
-- ==========================================================================
DO $$
DECLARE
  v_branch_id bigint;
  v_table text;
BEGIN
  SELECT id INTO v_branch_id FROM public.branches ORDER BY id LIMIT 1;
  IF v_branch_id IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna fila en public.branches -- no se puede hacer bootstrap de branch_id.';
  END IF;

  FOREACH v_table IN ARRAY ARRAY['products', 'modifiers', 'promotions']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = v_table AND column_name = 'branch_id'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN branch_id bigint REFERENCES public.branches(id)', v_table);
    END IF;

    EXECUTE format('UPDATE public.%I SET branch_id = %s WHERE branch_id IS NULL', v_table, v_branch_id);
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN branch_id SET NOT NULL', v_table);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_branch_id ON public.%I (branch_id)', v_table, v_table);
  END LOOP;
END $$;

-- ==========================================================================
-- 2. RLS: candado completo (SELECT incluido) para products y modifiers.
--    Igual que 20260820010000: loop dinámico para no depender de nombres
--    de policy viejos.
-- ==========================================================================
DO $$
DECLARE
  v_table text;
  v_policy record;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['products', 'modifiers']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    FOR v_policy IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = v_table LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', v_policy.policyname, v_table);
    END LOOP;
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO anon USING (false) WITH CHECK (false)', v_table || '_deny_anon_direct', v_table);
  END LOOP;
END $$;

-- ==========================================================================
-- 3. RPC de LECTURA (reemplazan los .select() directos que este candado
--    rompe -- catalog-renderer.js, sales-renderer.js, comandas-renderer.js
--    del escritorio, y wing-house-web/src/components/comandas.jsx +
--    ModifierBottomSheet.jsx).
-- ==========================================================================

-- Catálogo completo con TODAS las columnas -- para las pantallas de
-- administración (Catálogo, editar producto) y para POS/Comandas del
-- escritorio, que hoy leen getAllProducts() completo.
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

GRANT EXECUTE ON FUNCTION public.get_products_by_branch(bigint) TO anon;

-- Menú para vender (web/comandas): producto + si exige elegir salsa (para
-- decidir en el cliente si abrir el selector antes de agregar al
-- carrito) -- mismo dato que hoy arma comandas.jsx con dos queries
-- (products + product_modifier_groups). product_modifier_groups no tiene
-- columna branch_id propia -- queda acotada aquí por el join a products.
CREATE OR REPLACE FUNCTION public.get_menu_by_branch(p_branch_id bigint)
RETURNS TABLE (
  id bigint,
  name text,
  price numeric,
  employee_price numeric,
  category text,
  active boolean,
  sort_order integer,
  stock numeric,
  modifier_groups json
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.id, p.name, p.price, p.employee_price, p.category, p.active, p.sort_order, p.stock,
    COALESCE(
      (SELECT json_agg(json_build_object('group_name', pmg.group_name, 'qty', pmg.qty))
       FROM public.product_modifier_groups pmg WHERE pmg.product_id = p.id),
      '[]'::json
    ) AS modifier_groups
  FROM public.products p
  WHERE p.branch_id = p_branch_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_menu_by_branch(bigint) TO anon;

-- Modificadores (salsas) de un grupo -- reemplaza getModifiers(groupName)
-- de db.js y la query de ModifierBottomSheet.jsx. Mantiene el join a
-- inventory!inner(stock, unit) que ya tenía la versión original (excluye
-- modificadores cuyo insumo ligado se haya borrado).
-- Incluye qty_needed (cuánto de su insumo consume una porción, en la
-- unidad propia del insumo -- ver 20260819090200_salsa_stock_real.sql,
-- NO estaba en el borrador original de esta migración, se agregó al
-- releer esa migración antes de tocar la tabla).
CREATE OR REPLACE FUNCTION public.get_modifiers_by_branch(p_branch_id bigint, p_group_name text DEFAULT NULL)
RETURNS TABLE (
  id bigint,
  name text,
  group_name text,
  inventory_id bigint,
  price_extra numeric,
  qty_needed numeric,
  stock numeric,
  unit text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.id, m.name, m.group_name, m.inventory_id, m.price_extra, m.qty_needed, i.stock, i.unit
  FROM public.modifiers m
  JOIN public.inventory i ON i.id = m.inventory_id
  WHERE m.branch_id = p_branch_id
    AND (p_group_name IS NULL OR m.group_name = p_group_name)
  ORDER BY m.name;
$$;

GRANT EXECUTE ON FUNCTION public.get_modifiers_by_branch(bigint, text) TO anon;

-- ==========================================================================
-- 4. RPC de ESCRITURA (reemplazan los .insert()/.update()/.delete()
--    directos a products/modifiers -- createProduct/updateProduct/
--    adjustProductStock/removeProduct/updateModifier/
--    migrateAlitasBonelessCategories en db.js).
-- ==========================================================================
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

-- migrateAlitasBonelessCategories: limpieza de datos legados, ahora
-- acotada a una sola sucursal por llamada (db.init() la corre para la
-- sucursal de esta instalación en cada arranque).
CREATE OR REPLACE FUNCTION public.migrate_alitas_boneless_categories(p_branch_id bigint)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row record;
  v_to_alitas int := 0;
  v_to_boneless int := 0;
  v_target text;
BEGIN
  FOR v_row IN
    SELECT id, name, category FROM public.products
    WHERE branch_id = p_branch_id
      AND (category = 'Alitas y Boneless' OR category = 'alitas' OR category = 'boneless')
  LOOP
    v_target := CASE WHEN v_row.name ~* 'boneless' THEN 'Boneless' ELSE 'Alitas' END;
    IF v_row.category = v_target THEN CONTINUE; END IF;
    UPDATE public.products SET category = v_target WHERE id = v_row.id;
    IF v_target = 'Boneless' THEN v_to_boneless := v_to_boneless + 1; ELSE v_to_alitas := v_to_alitas + 1; END IF;
  END LOOP;
  RETURN json_build_object('toAlitas', v_to_alitas, 'toBoneless', v_to_boneless);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_product(bigint, text, text, numeric, numeric, boolean, integer, numeric) TO anon;
GRANT EXECUTE ON FUNCTION public.update_product(bigint, bigint, text, text, numeric, numeric, boolean, integer, numeric) TO anon;
GRANT EXECUTE ON FUNCTION public.adjust_product_stock(bigint, bigint, numeric) TO anon;
GRANT EXECUTE ON FUNCTION public.remove_product(bigint, bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.update_modifier(bigint, bigint, text, bigint, numeric) TO anon;
GRANT EXECUTE ON FUNCTION public.migrate_alitas_boneless_categories(bigint) TO anon;

-- ==========================================================================
-- 5. CLONADOR DE CATÁLOGO (Tarea 3) -- alta de un cliente nuevo a partir
--    del catálogo de otra sucursal ya configurada.
--
-- Clona, con mapeo de ids (nunca copia un id de otra sucursal tal cual,
-- eso reabriría el cruce que se acaba de cerrar):
--   inventory (insumos) -- stock arranca en 0: el cliente nuevo NO hereda
--     existencia física de otra sucursal, solo la lista de insumos y sus
--     costos/unidades para que pueda empezar a capturar la suya.
--   products, modifiers (con inventory_id remapeado al insumo clonado),
--   product_modifier_groups (product_id remapeado; group_name es texto
--     libre, no necesita remapeo),
--   recipes (product_id e insumo_id remapeados),
--   product_components (parent/component product_id remapeados),
--   promotions.
-- Bloquea el clonado si la sucursal destino YA tiene productos -- esta
-- función es para el alta inicial, no para fusionar catálogos.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.clone_catalog_to_branch(p_source_branch_id bigint, p_target_branch_id bigint)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
  v_new_id bigint;
  v_products int := 0;
  v_inventory int := 0;
  v_modifiers int := 0;
  v_groups int := 0;
  v_recipes int := 0;
  v_components int := 0;
  v_promotions int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_source_branch_id) THEN
    RAISE EXCEPTION 'La sucursal origen % no existe.', p_source_branch_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_target_branch_id) THEN
    RAISE EXCEPTION 'La sucursal destino % no existe.', p_target_branch_id;
  END IF;
  IF p_source_branch_id = p_target_branch_id THEN
    RAISE EXCEPTION 'Origen y destino no pueden ser la misma sucursal.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.products WHERE branch_id = p_target_branch_id) THEN
    RAISE EXCEPTION 'La sucursal % ya tiene productos -- clone_catalog_to_branch es solo para el alta inicial de un cliente nuevo, no fusiona catálogos.', p_target_branch_id;
  END IF;

  CREATE TEMP TABLE _map_inventory (old_id bigint PRIMARY KEY, new_id bigint) ON COMMIT DROP;
  CREATE TEMP TABLE _map_products (old_id bigint PRIMARY KEY, new_id bigint) ON COMMIT DROP;

  -- 1) Insumos -- stock en 0 a propósito, ver comentario arriba.
  FOR v_row IN SELECT * FROM public.inventory WHERE branch_id = p_source_branch_id LOOP
    INSERT INTO public.inventory (name, category, unit, stock, min_stock, cost_per_unit, branch_id)
    VALUES (v_row.name, v_row.category, v_row.unit, 0, v_row.min_stock, v_row.cost_per_unit, p_target_branch_id)
    RETURNING id INTO v_new_id;
    INSERT INTO _map_inventory VALUES (v_row.id, v_new_id);
    v_inventory := v_inventory + 1;
  END LOOP;

  -- 2) Productos.
  FOR v_row IN SELECT * FROM public.products WHERE branch_id = p_source_branch_id LOOP
    INSERT INTO public.products (name, category, price, employee_price, active, sort_order, stock, branch_id)
    VALUES (v_row.name, v_row.category, v_row.price, v_row.employee_price, v_row.active, v_row.sort_order, v_row.stock, p_target_branch_id)
    RETURNING id INTO v_new_id;
    INSERT INTO _map_products VALUES (v_row.id, v_new_id);
    v_products := v_products + 1;
  END LOOP;

  -- 3) Modificadores (salsas) -- inventory_id remapeado; si el insumo
  --    ligado no se clonó (no debería pasar, se clonan todos), queda NULL.
  FOR v_row IN SELECT * FROM public.modifiers WHERE branch_id = p_source_branch_id LOOP
    INSERT INTO public.modifiers (name, group_name, inventory_id, price_extra, branch_id)
    VALUES (
      v_row.name, v_row.group_name,
      (SELECT new_id FROM _map_inventory WHERE old_id = v_row.inventory_id),
      v_row.price_extra, p_target_branch_id
    );
    v_modifiers := v_modifiers + 1;
  END LOOP;

  -- 4) Qué productos exigen qué grupo de modificadores.
  FOR v_row IN
    SELECT pmg.* FROM public.product_modifier_groups pmg
    JOIN public.products p ON p.id = pmg.product_id
    WHERE p.branch_id = p_source_branch_id
  LOOP
    INSERT INTO public.product_modifier_groups (product_id, group_name, qty)
    VALUES ((SELECT new_id FROM _map_products WHERE old_id = v_row.product_id), v_row.group_name, v_row.qty);
    v_groups := v_groups + 1;
  END LOOP;

  -- 5) Recetas (insumos que consume cada producto) -- product_id e
  --    insumo_id remapeados; se salta si el insumo referenciado no existe
  --    en el catálogo origen (dato huérfano, no debería pasar).
  FOR v_row IN
    SELECT r.* FROM public.recipes r
    JOIN public.products p ON p.id = r.product_id
    WHERE p.branch_id = p_source_branch_id
  LOOP
    IF (SELECT new_id FROM _map_inventory WHERE old_id = v_row.insumo_id) IS NULL THEN CONTINUE; END IF;
    INSERT INTO public.recipes (product_id, insumo_id, quantity_needed)
    VALUES (
      (SELECT new_id FROM _map_products WHERE old_id = v_row.product_id),
      (SELECT new_id FROM _map_inventory WHERE old_id = v_row.insumo_id),
      v_row.quantity_needed
    );
    v_recipes := v_recipes + 1;
  END LOOP;

  -- 6) Combos (producto -> producto componente).
  FOR v_row IN
    SELECT pc.* FROM public.product_components pc
    JOIN public.products p ON p.id = pc.parent_product_id
    WHERE p.branch_id = p_source_branch_id
  LOOP
    IF (SELECT new_id FROM _map_products WHERE old_id = v_row.component_product_id) IS NULL THEN CONTINUE; END IF;
    INSERT INTO public.product_components (parent_product_id, component_product_id, qty)
    VALUES (
      (SELECT new_id FROM _map_products WHERE old_id = v_row.parent_product_id),
      (SELECT new_id FROM _map_products WHERE old_id = v_row.component_product_id),
      v_row.qty
    );
    v_components := v_components + 1;
  END LOOP;

  -- 7) Promociones.
  FOR v_row IN SELECT * FROM public.promotions WHERE branch_id = p_source_branch_id LOOP
    INSERT INTO public.promotions (name, description, price, active, applicable_category, branch_id)
    VALUES (v_row.name, v_row.description, v_row.price, v_row.active, v_row.applicable_category, p_target_branch_id);
    v_promotions := v_promotions + 1;
  END LOOP;

  RETURN json_build_object(
    'inventory', v_inventory, 'products', v_products, 'modifiers', v_modifiers,
    'modifier_groups', v_groups, 'recipes', v_recipes, 'components', v_components,
    'promotions', v_promotions
  );
END;
$$;

-- ==========================================================================
-- 6. RPC de recetas / combos / grupos de modificadores.
--
-- Ninguna de estas 3 tablas (recipes, product_components,
-- product_modifier_groups) tiene columna branch_id propia -- siguen
-- acotadas por su product_id, como ya se había decidido. PERO al cerrar
-- products por completo (paso 2 de esta migración), los .select() de
-- db.js que traían datos EMBEBIDOS de products (component:..., parent:...,
-- products:product_id(...)) se rompen para anon -- RLS también aplica a
-- los joins embebidos de PostgREST. Y getRecipesForProduct/
-- setRecipesForProduct ya no tenían ninguna forma de validar que
-- productId fuera de esta sucursal (antes ni siquiera lo intentaban, era
-- el hallazgo "Arq." de la auditoría original). Por eso estas 3 tablas
-- también necesitan su capa de RPC, aunque no tengan columna branch_id.
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.get_product_modifier_groups_by_branch(p_branch_id bigint)
RETURNS SETOF public.product_modifier_groups
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT pmg.* FROM public.product_modifier_groups pmg
  JOIN public.products p ON p.id = pmg.product_id
  WHERE p.branch_id = p_branch_id;
$$;

CREATE OR REPLACE FUNCTION public.set_product_modifier_group(p_branch_id bigint, p_product_id bigint, p_group_name text, p_enabled boolean, p_qty integer DEFAULT 1)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró el producto % en esta sucursal', p_product_id;
  END IF;

  DELETE FROM public.product_modifier_groups WHERE product_id = p_product_id AND group_name = p_group_name;

  IF p_enabled THEN
    INSERT INTO public.product_modifier_groups (product_id, group_name, qty)
    VALUES (p_product_id, p_group_name, GREATEST(1, COALESCE(p_qty, 1)));
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_components_for_product(p_branch_id bigint, p_product_id bigint)
RETURNS TABLE (id bigint, parent_product_id bigint, component_product_id bigint, qty numeric, component_name text, component_price numeric)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT pc.id, pc.parent_product_id, pc.component_product_id, pc.qty, c.name, c.price
  FROM public.product_components pc
  JOIN public.products p ON p.id = pc.parent_product_id
  JOIN public.products c ON c.id = pc.component_product_id
  WHERE p.branch_id = p_branch_id AND pc.parent_product_id = p_product_id;
$$;

CREATE OR REPLACE FUNCTION public.set_components_for_product(p_branch_id bigint, p_product_id bigint, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row jsonb; v_count integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró el producto % en esta sucursal', p_product_id;
  END IF;

  DELETE FROM public.product_components WHERE parent_product_id = p_product_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) LOOP
    IF (v_row->>'component_product_id') IS NULL
       OR (v_row->>'component_product_id')::bigint = p_product_id
       OR COALESCE((v_row->>'qty')::numeric, 0) <= 0
    THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = (v_row->>'component_product_id')::bigint AND branch_id = p_branch_id) THEN
      RAISE EXCEPTION 'El componente % no pertenece a esta sucursal', v_row->>'component_product_id';
    END IF;
    INSERT INTO public.product_components (parent_product_id, component_product_id, qty)
    VALUES (p_product_id, (v_row->>'component_product_id')::bigint, (v_row->>'qty')::numeric);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_all_product_components_by_branch(p_branch_id bigint)
RETURNS TABLE (id bigint, parent_product_id bigint, parent_name text, component_product_id bigint, component_name text, qty numeric)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT pc.id, pc.parent_product_id, p.name, pc.component_product_id, c.name, pc.qty
  FROM public.product_components pc
  JOIN public.products p ON p.id = pc.parent_product_id
  JOIN public.products c ON c.id = pc.component_product_id
  WHERE p.branch_id = p_branch_id;
$$;

CREATE OR REPLACE FUNCTION public.get_recipes_for_product(p_branch_id bigint, p_product_id bigint)
RETURNS TABLE (id bigint, product_id bigint, insumo_id bigint, quantity_needed numeric, insumo_name text, insumo_unit text, insumo_stock numeric, insumo_cost_per_unit numeric)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.product_id, r.insumo_id, r.quantity_needed, i.name, i.unit, i.stock, i.cost_per_unit
  FROM public.recipes r
  JOIN public.products p ON p.id = r.product_id
  JOIN public.inventory i ON i.id = r.insumo_id
  WHERE p.branch_id = p_branch_id AND r.product_id = p_product_id;
$$;

CREATE OR REPLACE FUNCTION public.set_recipes_for_product(p_branch_id bigint, p_product_id bigint, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row jsonb; v_count integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró el producto % en esta sucursal', p_product_id;
  END IF;

  DELETE FROM public.recipes WHERE product_id = p_product_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) LOOP
    IF (v_row->>'insumo_id') IS NULL OR COALESCE((v_row->>'quantity_needed')::numeric, 0) <= 0 THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.inventory WHERE id = (v_row->>'insumo_id')::bigint AND branch_id = p_branch_id) THEN
      RAISE EXCEPTION 'El insumo % no pertenece a esta sucursal', v_row->>'insumo_id';
    END IF;
    INSERT INTO public.recipes (product_id, insumo_id, quantity_needed)
    VALUES (p_product_id, (v_row->>'insumo_id')::bigint, (v_row->>'quantity_needed')::numeric);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_recipe_cost(p_branch_id bigint, p_product_id bigint)
RETURNS numeric
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT SUM(r.quantity_needed * COALESCE(i.cost_per_unit, 0))
  FROM public.recipes r
  JOIN public.products p ON p.id = r.product_id
  JOIN public.inventory i ON i.id = r.insumo_id
  WHERE p.branch_id = p_branch_id AND r.product_id = p_product_id;
$$;

CREATE OR REPLACE FUNCTION public.get_all_recipes_with_stock(p_branch_id bigint)
RETURNS TABLE (product_id bigint, product_name text, insumo_id bigint, insumo_name text, insumo_unit text, insumo_stock numeric, insumo_min_stock numeric, quantity_needed numeric)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT r.product_id, p.name, r.insumo_id, i.name, i.unit, i.stock, i.min_stock, r.quantity_needed
  FROM public.recipes r
  JOIN public.products p ON p.id = r.product_id
  JOIN public.inventory i ON i.id = r.insumo_id
  WHERE p.branch_id = p_branch_id;
$$;

CREATE OR REPLACE FUNCTION public.get_product_ids_with_recipe(p_branch_id bigint)
RETURNS TABLE (product_id bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT r.product_id
  FROM public.recipes r
  JOIN public.products p ON p.id = r.product_id
  WHERE p.branch_id = p_branch_id;
$$;

CREATE OR REPLACE FUNCTION public.get_all_recipe_costs(p_branch_id bigint)
RETURNS TABLE (product_id bigint, cost numeric)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT r.product_id, SUM(r.quantity_needed * COALESCE(i.cost_per_unit, 0))
  FROM public.recipes r
  JOIN public.products p ON p.id = r.product_id
  JOIN public.inventory i ON i.id = r.insumo_id
  WHERE p.branch_id = p_branch_id
  GROUP BY r.product_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_product_modifier_groups_by_branch(bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.set_product_modifier_group(bigint, bigint, text, boolean, integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_components_for_product(bigint, bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.set_components_for_product(bigint, bigint, jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.get_all_product_components_by_branch(bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.get_recipes_for_product(bigint, bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.set_recipes_for_product(bigint, bigint, jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.get_recipe_cost(bigint, bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.get_all_recipes_with_stock(bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.get_product_ids_with_recipe(bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.get_all_recipe_costs(bigint) TO anon;

-- Sin GRANT a anon a propósito: dar de alta un cliente nuevo es una
-- operación de onboarding, no algo que dispare la app -- córrela desde el
-- SQL Editor (rol postgres/service_role) cuando vendas a una sucursal
-- nueva: SELECT clone_catalog_to_branch(1, 2);

-- ==========================================================================
-- PENDIENTE -- settings: correr esto en el SQL Editor y pasarme el
-- resultado antes de que yo pueda escribir la migración de settings.
-- ==========================================================================
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='settings';
--
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint WHERE conrelid = 'public.settings'::regclass;
--
-- SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'set_setting';
