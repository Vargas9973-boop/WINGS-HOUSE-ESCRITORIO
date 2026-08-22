-- Opción A -- Auditoría final branch_id, Prioridad 1: sale_items y
-- sale_item_modifiers hoy tienen "allow_anon_all" (USING/WITH CHECK true) en
-- prod -- 20260820010000 todavía NO se ha aplicado, así que ni siquiera está
-- vigente el estado intermedio "SELECT abierto, escritura negada" que ese
-- archivo documenta como Fase 1. Sin RLS real de lectura aquí no hay
-- multi-tenant real: cualquiera con la anon key puede leer sale_items/
-- sale_item_modifiers de CUALQUIER sucursal directo contra la API REST,
-- filtrado solo del lado del cliente (db.js/wing-house-web).
--
-- Este archivo hace lo que 20260820010000 dejó como "DEUDA PENDIENTE / Fase
-- 2" pero SOLO para estas dos tablas (las de mayor prioridad, ver auditoría
-- del usuario 2026-08-20): cierra también SELECT (deny_anon_direct, FOR ALL
-- USING(false)) y agrega los 2 RPC de lectura que hacen falta para no
-- romper los 9 sitios que hoy leen sale_items directo (8 en db.js, 1 en
-- wing-house-web/comandas.jsx):
--   - get_sale_items_with_modifiers(p_branch_id, p_sale_ids[]) -- reemplaza
--     el patrón `.from('sale_items').select('*, sale_item_modifiers(id,
--     modifier_id))').eq/in('sale_id', ...)` (createSale/comanda web,
--     getSaleById, getOpenSaleByTable, getOpenSaleById, getKdsOrders,
--     getUnifiedHistory). Devuelve SETOF json con TODAS las columnas de
--     sale_items (to_jsonb) + sale_item_modifiers como array anidado,
--     exactamente la misma forma que el embed de PostgREST producía, para
--     no tener que tocar la lógica de agregación en JS de cada llamador.
--   - get_sale_items_summary(p_branch_id, p_from, p_to) -- reemplaza el
--     patrón `.from('sale_items').select('name, quantity, subtotal,
--     sales!inner(status, created_at, branch_id))')` usado por
--     getProductsSummary y el reporte de rentabilidad (ambos ya agregan en
--     JS, aquí solo se filtra por sucursal/fecha/status='completada' y se
--     devuelven las filas crudas).
--
-- Los nombres/tipos de columna se resuelven con %TYPE contra sale_items en
-- vez de adivinar (mismo motivo que products.category_id en trabajos
-- previos: este repo ya se quemó escribiendo DDL contra un esquema
-- asumido). No se toca sale_item_modifiers como tabla independiente porque
-- ningún sitio en db.js/wing-house-web la consulta sola -- solo aparece
-- embebida dentro de sale_items, así que get_sale_items_with_modifiers
-- (SECURITY DEFINER, corre con privilegios del dueño) cubre también su
-- cierre de lectura sin necesitar un RPC aparte.

-- ==========================================================================
-- 1. RPC de lectura
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.get_sale_items_with_modifiers(p_branch_id bigint, p_sale_ids bigint[])
RETURNS SETOF json
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT to_jsonb(si) || jsonb_build_object(
    'sale_item_modifiers',
    COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('id', sim.id, 'modifier_id', sim.modifier_id) ORDER BY sim.id)
         FROM public.sale_item_modifiers sim
        WHERE sim.sale_item_id = si.id),
      '[]'::jsonb
    )
  )
  FROM public.sale_items si
  JOIN public.sales s ON s.id = si.sale_id
  WHERE si.sale_id = ANY(p_sale_ids)
    AND s.branch_id = p_branch_id
  ORDER BY si.id;
$$;

GRANT EXECUTE ON FUNCTION public.get_sale_items_with_modifiers(bigint, bigint[]) TO anon;

CREATE OR REPLACE FUNCTION public.get_sale_items_summary(p_branch_id bigint, p_from timestamptz, p_to timestamptz)
RETURNS TABLE(name sale_items.name%TYPE, quantity sale_items.quantity%TYPE, subtotal sale_items.subtotal%TYPE)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT si.name, si.quantity, si.subtotal
  FROM public.sale_items si
  JOIN public.sales s ON s.id = si.sale_id
  WHERE s.branch_id = p_branch_id
    AND s.status = 'completada'
    AND s.created_at >= p_from
    AND s.created_at <= p_to;
$$;

GRANT EXECUTE ON FUNCTION public.get_sale_items_summary(bigint, timestamptz, timestamptz) TO anon;

-- ==========================================================================
-- 2. Cierre de RLS -- dinámico (dropea CUALQUIER policy existente, sin
--    adivinar el nombre: hoy es "allow_anon_all" en prod, pero si
--    20260820010000 llegara a correr antes que este archivo en alguna
--    instalación dejaría "sale_items_select_anon" etc. en su lugar; este
--    loop cubre ambos casos igual que el patrón ya usado en 010000/000012).
-- ==========================================================================
DO $$
DECLARE
  v_table text;
  v_policy record;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['sale_items', 'sale_item_modifiers']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);

    FOR v_policy IN
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = v_table
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', v_policy.policyname, v_table);
    END LOOP;

    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO anon USING (false) WITH CHECK (false)', 'deny_anon_direct', v_table);
  END LOOP;
END $$;
