-- Punto 2 del audit SaaS, fase 2: RLS deja de ser USING (true). Depende de
-- supabase/functions/login (sesión real de Supabase Auth, ya conectada a
-- db.js y wing-house-web/Login.jsx) -- sin eso, auth.uid() nunca es real y
-- este archivo no tendría ningún efecto útil.
--
-- Mapeo hecho a mano contra el código real (no adivinado) antes de escribir
-- esto:
--   - TODAS las escrituras (insert/update/delete) de ambas apps ya pasan
--     por RPCs SECURITY DEFINER -- confirmado con grep exhaustivo sobre
--     db.js y wing-house-web/src. La ÚNICA excepción es `users`
--     (changePassword/updateUser/removeUser/createUser siguen escribiendo
--     directo). Por eso casi todas las tablas de abajo solo reciben una
--     policy de SELECT -- ninguna policy de escritura, así que insert/
--     update/delete quedan cerrados por default (RPC-only), que es
--     exactamente lo que ya pasaba de facto.
--   - `sales`: el único lugar que la lee SIN sesión es getKdsOrders() (KDS
--     "sin login", ver comentario en db.js línea ~1417) -- se mueve a un
--     RPC nuevo (get_kds_orders) para poder cerrar `sales` a anon sin
--     romper la TV de cocina desatendida.
--   - `branches`: RLS nunca se había activado (bug encontrado ahora). Se
--     deja SELECT abierto a anon a propósito -- getAllBranches() se llama
--     ANTES del login (bootstrap de sucursal), y el dato (nombre/
--     dirección/teléfono de la sucursal) no es sensible.
--   - `unit_conversions`/`drivers`: sin branch_id, no se tocan (unit_
--     conversions es catálogo global; drivers ya tiene un bug previo sin
--     relación con esto -- getDrivers() filtra por una columna branch_id
--     que esa tabla no tiene, así que ya falla hoy; no se arregla aquí,
--     fuera de alcance de este punto).
--   - `comandas`/`role_permissions`/`product_components`/
--     `product_modifier_groups`/`sale_items`/`sale_item_modifiers`/
--     `categories`: sin lectura directa desde ninguna de las dos apps
--     (confirmado con grep) -- ya cerradas o se cierran aquí sin impacto.
--   - `inventory_movements`: sin branch_id propio, se escanea vía JOIN a
--     inventory.branch_id (insumo_id -> inventory.id). Hallazgo real:
--     getInventoryMovements() hoy no filtra por sucursal en ningún lado
--     (ni cliente ni RLS) -- esta policy lo cierra de una vez.
--
-- Todas las policies nuevas son SOLO SELECT, para `authenticated`. No se
-- agrega ninguna policy de escritura -- si algo necesita escribir directo
-- en el futuro, que sea explícito (RPC nuevo o policy nueva), no un default
-- abierto.

-- ==========================================================================
-- 0. Fundamento: auth_user_id + helper de sesión
-- ==========================================================================
ALTER TABLE public.users ADD COLUMN auth_user_id uuid UNIQUE REFERENCES auth.users(id);

-- Backfill de los 2 usuarios reales que ya tenían auth.users desde antes de
-- esta sesión (creados 2026-08-15, sin relación con este trabajo). Login
-- futuros los mantienen sincronizados vía la Edge Function.
UPDATE public.users u
SET auth_user_id = au.id
FROM auth.users au
WHERE au.email = u.email AND u.auth_user_id IS NULL;

-- SECURITY DEFINER: necesita leer public.users saltándose la RLS que este
-- mismo archivo le va a poner a esa tabla (si no, recursión/deadlock de
-- policy). search_path fijo por seguridad (bloquea hijacking de search_path
-- en una función SECURITY DEFINER).
CREATE OR REPLACE FUNCTION public.current_branch_id()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT branch_id FROM public.users WHERE auth_user_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.current_branch_id() TO anon, authenticated;

-- ==========================================================================
-- 1. KDS sin login: mover el único read directo de `sales` que corre como
--    anon a un RPC branch-scoped server-side, mismo patrón que ya usan
--    get_sale_items_with_modifiers / get_all_product_components_by_branch
--    en esta misma función (getKdsOrders() en db.js).
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.get_kds_orders(p_branch_id bigint)
RETURNS TABLE(
  id bigint, table_number integer, client_type text, folio text, status text,
  created_at timestamptz, kds_status text, kds_started_at timestamptz,
  kds_ready_at timestamptz, is_delivery boolean, delivery_fee numeric,
  driver_name text, total numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, table_number, client_type, folio, status, created_at,
         kds_status, kds_started_at, kds_ready_at, is_delivery, delivery_fee,
         driver_name, total
  FROM public.sales
  WHERE branch_id = p_branch_id
    AND kds_status IS DISTINCT FROM 'entregada'
    AND status IS DISTINCT FROM 'cancelada'
  ORDER BY created_at ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_kds_orders(bigint) TO anon, authenticated;

-- ==========================================================================
-- 2. Tablas con branch_id propio: SELECT (authenticated) = mi sucursal.
--    Sin policy de escritura -- ya es RPC-only en la práctica.
-- ==========================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'attendance', 'cash_cuts', 'cash_movements', 'costs', 'employees',
    'inventory', 'promotions', 'roles', 'settings', 'waste', 'categories',
    'products', 'recipes', 'modifiers', 'payroll_deductions',
    'payroll_history', 'payroll_weeks'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS allow_anon_all ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "Permitir todo a usuarios anonimos" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS deny_anon_direct ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_anon', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert_deny_anon', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update_deny_anon', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete_deny_anon', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (branch_id = public.current_branch_id())',
      t || '_select_own_branch', t
    );
  END LOOP;
END $$;

-- Nombres de policy que no siguen el patrón genérico de arriba -- se
-- dropean explícito para no dejarlas coexistiendo con la nueva (Postgres
-- evalúa todas las policies de un rol/comando con OR, así que una vieja
-- USING(true) que sobreviva anula por completo la restrictiva).
DROP POLICY IF EXISTS employees_select_policy ON public.employees;
DROP POLICY IF EXISTS employees_insert_policy ON public.employees;
DROP POLICY IF EXISTS employees_update_policy ON public.employees;
DROP POLICY IF EXISTS employees_delete_policy ON public.employees;
DROP POLICY IF EXISTS roles_allow_anon_all ON public.roles;

-- ==========================================================================
-- 3. sales: mismo patrón, pero SIN policy de anon (el único uso sin sesión,
--    KDS, ya se movió al RPC de arriba). Las policies viejas de INSERT/
--    UPDATE (sales_insert_web, sales_update_anon) tampoco las usa nadie --
--    confirmado, cero .insert()/.update() directos a sales en ninguna app.
-- ==========================================================================
DROP POLICY IF EXISTS sales_select_anon ON public.sales;
DROP POLICY IF EXISTS sales_insert_web ON public.sales;
DROP POLICY IF EXISTS sales_update_anon ON public.sales;

CREATE POLICY sales_select_own_branch ON public.sales
  FOR SELECT TO authenticated
  USING (branch_id = public.current_branch_id());

-- ==========================================================================
-- 4. users: caso especial -- sigue recibiendo INSERT/UPDATE directo desde
--    db.js (changePassword/updateUser/removeUser/createUser), todos ya
--    corriendo con sesión real (después del login). SELECT/INSERT/UPDATE
--    quedan acotados a la propia sucursal; sin policy de DELETE (removeUser
--    hace soft-delete con UPDATE active=false, nunca borra la fila).
-- ==========================================================================
DROP POLICY IF EXISTS "Allow all for authenticated" ON public.users;
DROP POLICY IF EXISTS users_insert_anon ON public.users;
DROP POLICY IF EXISTS "Permitir lectura de usuarios activos" ON public.users;
DROP POLICY IF EXISTS users_select_anon ON public.users;
DROP POLICY IF EXISTS users_update_anon ON public.users;

CREATE POLICY users_select_own_branch ON public.users
  FOR SELECT TO authenticated
  USING (branch_id = public.current_branch_id());

CREATE POLICY users_insert_own_branch ON public.users
  FOR INSERT TO authenticated
  WITH CHECK (branch_id = public.current_branch_id());

CREATE POLICY users_update_own_branch ON public.users
  FOR UPDATE TO authenticated
  USING (branch_id = public.current_branch_id())
  WITH CHECK (branch_id = public.current_branch_id());

-- ==========================================================================
-- 5. inventory_movements: sin branch_id propio -- se escanea vía JOIN.
--    Hallazgo real: hoy no tiene NINGÚN filtro de sucursal (ni cliente ni
--    RLS) -- getInventoryMovements() en db.js solo filtra por insumo_id.
-- ==========================================================================
ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_anon_all ON public.inventory_movements;

CREATE POLICY inventory_movements_select_own_branch ON public.inventory_movements
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory i
      WHERE i.id = insumo_id AND i.branch_id = public.current_branch_id()
    )
  );

-- ==========================================================================
-- 6. branches: RLS nunca se había activado (bug encontrado en este audit).
--    SELECT se deja abierta a anon a propósito -- getAllBranches() corre
--    ANTES del login (bootstrap de sucursal del escritorio) y el dato no es
--    sensible. Sin policy de escritura (nada la usa hoy).
-- ==========================================================================
ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;

CREATE POLICY branches_select_all ON public.branches
  FOR SELECT TO anon, authenticated
  USING (true);

-- ==========================================================================
-- 7. Tablas ya sin lectura directa desde ninguna app -- se cierran del
--    todo (sin policy = default deny), consistente con role_permissions/
--    product_components/etc. que ya estaban así.
-- ==========================================================================
DROP POLICY IF EXISTS "Permitir todo a usuarios anonimos" ON public.comandas;
DROP POLICY IF EXISTS role_permissions_allow_anon_all ON public.role_permissions;

ALTER TABLE public.comandas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
