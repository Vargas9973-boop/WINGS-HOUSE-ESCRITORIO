-- La policy "Allow all for anon" en public.users otorgaba FOR ALL (SELECT,
-- INSERT, UPDATE, DELETE) a cualquiera con la anon key. SELECT/INSERT/UPDATE
-- son necesarios hoy porque db.js (escritorio) hace login comparando
-- password_hash del lado del cliente, sin service_role. DELETE no lo usa
-- nadie: removeUser() solo hace soft-delete (active=false). Se retira DELETE
-- para que ya no sea posible borrar todas las cuentas con la anon key.
--
-- Pendiente (fuera de esta migración, requiere tocar db.js del escritorio):
-- mover la verificación de login a un RPC SECURITY DEFINER para dejar de
-- exponer password_hash/password_salt vía SELECT directo.
DROP POLICY IF EXISTS "Allow all for anon" ON public.users;

CREATE POLICY "users_select_anon" ON public.users
  FOR SELECT TO anon
  USING (true);

CREATE POLICY "users_insert_anon" ON public.users
  FOR INSERT TO anon
  WITH CHECK (true);

CREATE POLICY "users_update_anon" ON public.users
  FOR UPDATE TO anon
  USING (true)
  WITH CHECK (true);
