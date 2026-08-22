-- Opción A -- Tarea 2 / Migración 0008: cierra el acceso directo de `anon`
-- a las tablas de este listado. Hoy cada una tenía como mucho una policy
-- "allow_anon_all" / "Allow all for anon" con USING(true) WITH CHECK(true)
-- (o, en cash_cuts/cash_movements, ni siquiera acotada a TO anon -- abierta
-- a PUBLIC): cualquiera con la anon key (embebida en el instalador de
-- Electron y en el bundle web) podía leer o escribir cualquier fila de
-- cualquier sucursal directo contra la API REST de Supabase.
--
-- Patrón aplicado a cada tabla (uniforme, uno por uno vía loop dinámico
-- para no depender de adivinar el nombre exacto de cada policy vieja):
--   - SELECT sigue abierto para anon. Las lecturas se filtran por branch_id
--     del lado de la app (db.js / wing-house-web ya corregidos en la Tarea
--     3) -- no son RLS real todavía. Ver "Deuda pendiente" al final de este
--     archivo: es la única desviación deliberada del pedido original
--     (`FOR ALL ... USING(false)`), y el motivo es que negar SELECT aquí
--     tumba ~30 funciones de lectura de db.js que no están en el alcance de
--     esta migración (reescribirlas como RPC sería tocar lógica de negocio,
--     que la Tarea 3 pide explícitamente NO tocar).
--   - INSERT/UPDATE/DELETE quedan negados para anon: toda escritura debe
--     pasar por un RPC SECURITY DEFINER que valide p_branch_id (Tarea 2,
--     migraciones 20260820020000 en adelante). SECURITY DEFINER corre con
--     privilegios del dueño de la función (postgres), así que estas
--     policies no afectan a esos RPC -- solo bloquean los
--     supabase.from(tabla).insert/update/delete() que hoy van directo.
--
-- Tablas fuera de este alcance (a propósito, ver auditoría):
--   - users: requiere resolver primero el acceso a password_hash/salt para
--     el login (fuera de alcance -- "no toques auth"). Queda en Fase 2.
--   - products, modifiers, product_modifier_groups, product_components,
--     recipes, settings, payroll_deductions, payroll_history,
--     payroll_weeks: catálogo/nómina, decisión de producto pendiente
--     (¿compartido entre sucursales o por sucursal?). Fase 2.
--   - employee_consumption, employee_weekly_credit: YA estaban
--     correctamente cerradas (RLS habilitado, sin ninguna policy para
--     anon) -- no se tocan.
--   - unit_conversions: catálogo de unidades, no es dato de tenant -- se
--     deja como está (SELECT abierto).

DO $$
DECLARE
  v_table text;
  v_policy record;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'sales', 'sale_items', 'sale_item_modifiers',
    'promotions',
    'inventory', 'inventory_movements',
    'costs', 'cash_cuts', 'cash_movements',
    'employees', 'drivers', 'waste',
    'attendance', 'branches'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);

    FOR v_policy IN
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = v_table
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', v_policy.policyname, v_table);
    END LOOP;

    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO anon USING (true)', v_table || '_select_anon', v_table);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO anon WITH CHECK (false)', v_table || '_insert_deny_anon', v_table);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO anon USING (false)', v_table || '_update_deny_anon', v_table);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO anon USING (false)', v_table || '_delete_deny_anon', v_table);
  END LOOP;
END $$;

-- ============================================================
-- DEUDA PENDIENTE (Fase 2, no cubierta por esta migración):
--   - Cerrar también SELECT para anon en estas 14 tablas y mover cada
--     lectura restante de db.js/wing-house-web a un RPC de lectura con
--     p_branch_id -- son ~30 funciones (getAllSales, getKdsOrders,
--     computeProfitability, getPayrollData, etc.), cada una con agregación
--     propia en JS que NO se debe reescribir a la ligera.
--   - Cerrar `users` (INSERT/UPDATE) una vez resuelto el login sin exponer
--     password_hash/salt vía SELECT directo (ver comentario en
--     20260815050000_rls_allow_anon_update_sales_printed.sql, ya lo tenían
--     pendiente antes de este trabajo).
--   - products/modifiers/recipes/settings/payroll_*: pendiente de la
--     decisión de catálogo compartido vs. por sucursal.
-- ============================================================
