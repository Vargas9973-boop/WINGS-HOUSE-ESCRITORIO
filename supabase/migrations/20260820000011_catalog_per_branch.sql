-- Opción A -- Migración 0011: registro histórico del estado de catálogo
-- por sucursal (categories/products/modifiers/product_components) tal
-- como quedó tras trabajo aplicado A MANO en producción el 2026-08-20 vía
-- SQL Editor. Este archivo se agrega al repo DESPUÉS del hecho, a partir
-- de introspección real (information_schema.columns, pg_constraint,
-- pg_policies, pg_get_functiondef), para que el historial de migraciones
-- quede alineado. Uso previsto en producción:
--   supabase migration repair --status applied 20260820000011
-- (marca la migración como ya aplicada SIN volver a ejecutar este SQL
-- contra producción). Si este archivo se corre en un ambiente nuevo
-- (dev/staging/disaster recovery), sí se ejecuta de verdad -- por eso
-- todo es idempotente (IF NOT EXISTS / DROP+CREATE POLICY).
--
-- *** ADVERTENCIA DE SEGURIDAD ***
-- Este archivo reproduce el estado real de producción INCLUYENDO una
-- fuga confirmada: products tiene, además de "deny_anon_direct" (USING
-- false), cuatro policies viejas (products_select/insert/update/delete)
-- con USING(true)/WITH CHECK(true) para {anon, authenticated} que datan
-- de antes de este trabajo de branch_id (no las creó ninguna migración
-- de este repo -- 20260820010000 excluyó products explícitamente). Como
-- las policies permissive se combinan con OR, anon puede hoy leer/
-- insertar/actualizar/borrar products directo pese a "deny_anon_direct".
-- Mismo patrón duplicado en modifiers y product_components
-- ("allow_anon_all" conviviendo con "deny_anon_direct").
-- LA FUGA SE CIERRA EN 20260820000012_catalog_admin_rpcs.sql, que debe
-- aplicarse junto con este archivo, no por separado.

-- ==========================================================================
-- 1. categories -- tabla nueva (no la creó ninguna migración anterior de
--    este repo; se dio de alta a mano junto con branch_id desde el
--    principio). Sin UNIQUE(name, branch_id) confirmado por introspección
--    -- no se agrega aquí para no inventar una restricción que prod no
--    tiene.
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.categories (
  id serial PRIMARY KEY,
  name varchar NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  branch_id bigint NOT NULL REFERENCES public.branches(id)
);

CREATE INDEX IF NOT EXISTS idx_categories_branch_id ON public.categories (branch_id);

ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS categories_deny_anon_direct ON public.categories;
CREATE POLICY categories_deny_anon_direct ON public.categories
  FOR ALL TO anon USING (false) WITH CHECK (false);

-- ==========================================================================
-- 2. products.category_id -- puente opcional hacia categories. Confirmado
--    por introspección: SIN foreign key (pg_constraint no devolvió nada
--    para category_id). No se agrega la FK aquí -- agregarla ahora sería
--    una decisión de esquema nueva, no un reflejo de lo que ya corriste.
--    products.category (texto libre, Alitas/Boneless) sigue siendo la
--    fuente de verdad hoy; category_id existe pero ningún RPC lo usa
--    todavía (ver get_menu_by_branch abajo, que solo devuelve category).
-- ==========================================================================
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS category_id integer;

-- ==========================================================================
-- 3. product_components.branch_id -- confirmado NULLABLE y SIN FK a
--    branches. Se refleja tal cual (no se hace backfill ni NOT NULL aquí
--    -- eso es justo lo que dijiste que no toque todavía).
-- ==========================================================================
ALTER TABLE public.product_components ADD COLUMN IF NOT EXISTS branch_id bigint;

-- ==========================================================================
-- 4. RLS de modifiers y product_components -- reflejo del estado real
--    (deny_anon_direct + allow_anon_all duplicadas, ambas activas).
--    products ya tiene RLS habilitado y sus 5 policies (incluida la fuga)
--    de antes de este trabajo -- no se tocan en este archivo.
-- ==========================================================================
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['modifiers', 'product_components']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);

    EXECUTE format('DROP POLICY IF EXISTS deny_anon_direct ON public.%I', v_table);
    EXECUTE format('CREATE POLICY deny_anon_direct ON public.%I FOR ALL TO anon USING (false) WITH CHECK (false)', v_table);

    EXECUTE format('DROP POLICY IF EXISTS allow_anon_all ON public.%I', v_table);
    EXECUTE format('CREATE POLICY allow_anon_all ON public.%I FOR ALL TO anon USING (true) WITH CHECK (true)', v_table);
  END LOOP;
END $$;

-- ==========================================================================
-- 5. Funciones de lectura ya existentes en producción -- cuerpo EXACTO
--    tomado de pg_get_functiondef, no reconstruido.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.get_menu_by_branch(p_branch_id bigint)
 RETURNS TABLE(product_id integer, product_name character varying, price numeric, category text, branch_id bigint)
 LANGUAGE sql SECURITY DEFINER AS $$
  SELECT id, name, price, category, branch_id
  FROM products
  WHERE branch_id = p_branch_id AND active = true
  ORDER BY sort_order;
$$;

GRANT EXECUTE ON FUNCTION public.get_menu_by_branch(bigint) TO anon;

CREATE OR REPLACE FUNCTION public.get_modifiers_by_branch(p_branch_id bigint)
 RETURNS SETOF modifiers LANGUAGE sql SECURITY DEFINER AS $$
  SELECT * FROM modifiers WHERE branch_id = p_branch_id AND active = true;
$$;

GRANT EXECUTE ON FUNCTION public.get_modifiers_by_branch(bigint) TO anon;

-- ==========================================================================
-- 6. clone_catalog_to_branch -- cuerpo EXACTO tomado de pg_get_functiondef
--    (ya no es reconstrucción). Nota: a diferencia del draft original,
--    esta versión real NO remapea modifiers.inventory_id al insumo
--    clonado (ni siquiera clona inventory) -- un catálogo clonado con
--    modifiers queda con inventory_id apuntando al insumo de la sucursal
--    ORIGEN, no uno nuevo. Se refleja tal cual, sin corregirlo aquí.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.clone_catalog_to_branch(p_source_branch_id bigint, p_target_branch_id bigint)
 RETURNS TABLE(cloned_products integer, cloned_categories integer, cloned_modifiers integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_prod INT; v_cat INT; v_mod INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM branches WHERE id=p_target_branch_id) THEN
    RAISE EXCEPTION 'Branch destino % no existe', p_target_branch_id;
  END IF;

  -- Clonar categorías
  INSERT INTO categories (name, branch_id)
  SELECT name, p_target_branch_id FROM categories WHERE branch_id=p_source_branch_id
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_cat = ROW_COUNT;

  -- Clonar productos
  INSERT INTO products (name, price, category_id, category, active, sort_order, stock, employee_price, branch_id)
  SELECT p.name, p.price,
         (SELECT id FROM categories WHERE name=(SELECT name FROM categories WHERE id=p.category_id) AND branch_id=p_target_branch_id LIMIT 1),
         p.category, p.active, p.sort_order, p.stock, p.employee_price, p_target_branch_id
  FROM products p WHERE p.branch_id=p_source_branch_id
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_prod = ROW_COUNT;

  -- Clonar modifiers
  INSERT INTO modifiers (name, group_name, price_extra, is_required, is_active, active, qty_needed, branch_id)
  SELECT name, group_name, price_extra, is_required, is_active, active, qty_needed, p_target_branch_id
  FROM modifiers WHERE branch_id=p_source_branch_id
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_mod = ROW_COUNT;

  RETURN QUERY SELECT v_prod, v_cat, v_mod;
END; $function$;

-- Sin GRANT a anon a propósito -- operación de onboarding, se corre desde
-- el SQL Editor (mismo criterio que el draft original).
