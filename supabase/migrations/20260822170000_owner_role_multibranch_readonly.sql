-- Rol "dueño": lectura multi-sucursal dentro del mismo tenant, sin tocar
-- escritura (sigue siendo una sola sucursal -- la de la instalación donde
-- está parado, vía current_branch_id() sin cambios). No hay jerarquía
-- "matriz -> sucursal secundaria" -- ese nivel ya lo resuelve tenants:
-- todas las sucursales de un mismo negocio comparten tenant_id, sin
-- relación de dependencia entre ellas. Dar de alta sucursales nuevas del
-- mismo negocio es una fila más en `branches` con el mismo tenant_id, nada
-- de esta migración.
--
-- Sin UI todavía -- solo el mecanismo de base de datos, verificado con
-- datos descartables. Nadie queda marcado is_owner=true por esta
-- migración (ni el admin real) -- eso es una decisión operativa aparte,
-- no algo para activar solo.

ALTER TABLE public.users ADD COLUMN is_owner boolean NOT NULL DEFAULT false;

-- Reemplaza a current_branch_id() SOLO para lectura: un usuario normal ve
-- exactamente su propia sucursal (mismo resultado que current_branch_id(),
-- como arreglo de 1 elemento); un dueño ve todas las sucursales activas de
-- SU MISMO tenant. Sigue respetando el kill-switch de tenants.active --
-- si el tenant está desactivado, el arreglo sale vacío igual que
-- current_branch_id() sale NULL hoy.
CREATE OR REPLACE FUNCTION public.current_visible_branch_ids()
RETURNS bigint[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN u.is_owner THEN
      COALESCE(
        ARRAY(SELECT b2.id FROM public.branches b2 WHERE b2.tenant_id = b.tenant_id),
        ARRAY[]::bigint[]
      )
    ELSE
      ARRAY[u.branch_id]
  END
  FROM public.users u
  JOIN public.branches b ON b.id = u.branch_id
  JOIN public.tenants t ON t.id = b.tenant_id
  WHERE u.auth_user_id = auth.uid()
    AND t.active = true;
$$;

GRANT EXECUTE ON FUNCTION public.current_visible_branch_ids() TO anon, authenticated;

-- Todas las policies de SELECT que hoy comparan branch_id = current_branch_id()
-- pasan a branch_id = ANY(current_visible_branch_ids()) -- para un usuario
-- normal es exactamente el mismo resultado (arreglo de 1 elemento). Se
-- deja el mismo nombre de policy en cada tabla -- solo cambia el USING.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'attendance', 'cash_cuts', 'cash_movements', 'costs', 'employees',
    'inventory', 'promotions', 'roles', 'settings', 'waste', 'categories',
    'products', 'recipes', 'modifiers', 'payroll_deductions',
    'payroll_history', 'payroll_weeks', 'sales', 'users',
    'sale_items', 'sale_item_modifiers', 'product_components',
    'product_modifier_groups'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_own_branch', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (branch_id = ANY (public.current_visible_branch_ids()))',
      t || '_select_own_branch', t
    );
  END LOOP;
END $$;

-- inventory_movements: mismo cambio, pero via el JOIN a inventory.branch_id
-- (no tiene branch_id propio).
DROP POLICY IF EXISTS inventory_movements_select_own_branch ON public.inventory_movements;
CREATE POLICY inventory_movements_select_own_branch ON public.inventory_movements
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory i
      WHERE i.id = insumo_id AND i.branch_id = ANY (public.current_visible_branch_ids())
    )
  );
