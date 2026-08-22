-- Opción A -- Auditoría final branch_id, Prioridad 2: recipes y
-- product_modifier_groups hoy tienen "allow_anon_all" (USING/WITH CHECK
-- true) en prod. Ninguna de las dos tiene columna branch_id propia -- se
-- acotan vía JOIN a products.branch_id, igual que ya hacía
-- clone_catalog_to_branch/get_menu_by_branch con products.
--
-- Debe aplicarse DESPUÉS de 20260820000013_catalog_component_recipe_modifier_group_rpcs.sql
-- (los RPC de lectura/escritura de esas dos tablas deben existir primero, o
-- catalog-renderer.js queda sin forma de leer/editar recetas y grupos de
-- modificadores en cuanto esta migración cierra SELECT).
--
-- product_components NO está en este archivo: ya está en deny_anon_direct
-- en prod desde antes (confirmado por el usuario), este archivo solo
-- cierra las 2 tablas que auditoría marcó como Prioridad 2.

DO $$
DECLARE
  v_table text;
  v_policy record;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['recipes', 'product_modifier_groups']
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
