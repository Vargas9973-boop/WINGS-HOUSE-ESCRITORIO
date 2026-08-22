-- Punto 2 del audit SaaS, fase 1b: defensa en profundidad para las 4
-- tablas que ya estaban cerradas (RLS on, cero policies para
-- `authenticated` -- deny-by-default, RPC-only) desde antes de
-- 20260822120000_rls_restrictive_phase1.sql. Confirmado con grep que hoy
-- nada las lee directo (comandas.jsx/Tablero.jsx/db.js usan
-- get_sale_items_with_modifiers / get_all_product_components_by_branch /
-- get_product_modifier_groups_by_branch, todos RPC SECURITY DEFINER).
--
-- Se les agrega la MISMA policy de SELECT branch-scoped que al resto de
-- fase 1, en vez de dejarlas dependiendo de "no hay policy = deny" -- así
-- si algún día alguien agrega un read directo (a propósito o por error),
-- cae en el mismo aislamiento por sucursal explícito que todo lo demás, no
-- en un cierre total silencioso que exigiría acordarse de este detalle.
-- No se toca ninguna policy de escritura -- sigue siendo RPC-only.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sale_items', 'sale_item_modifiers', 'product_components', 'product_modifier_groups'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (branch_id = public.current_branch_id())',
      t || '_select_own_branch', t
    );
  END LOOP;
END $$;
