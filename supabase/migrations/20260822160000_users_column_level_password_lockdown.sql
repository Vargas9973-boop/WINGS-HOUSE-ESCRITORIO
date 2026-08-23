-- Cierra el hueco column-level que quedó documentado en la fase de RLS:
-- RLS es por FILA, no por columna -- users_select_own_branch ya limita a
-- "mi propia sucursal", pero dentro de esa sucursal cualquier autenticado
-- podía pedir explícitamente password_hash/password_salt de OTRO usuario
-- (select=password_hash en vez de select=*) y el REST se los daba, porque
-- el GRANT de Supabase es a nivel de tabla completa, no filtra columnas.
--
-- Postgres no permite "revocar solo una columna" cuando el privilegio
-- viene de un GRANT a nivel de tabla (el grant de tabla sigue cubriendo esa
-- columna igual) -- hay que revocar la tabla completa y re-otorgar
-- explícito la lista de columnas seguras. Ninguna función de la app pide
-- password_hash/password_salt vía anon/authenticated (confirmado con
-- grep) -- el único lugar que las lee es la Edge Function `login`, que usa
-- el cliente service_role (no tocado por este REVOKE).

REVOKE SELECT ON public.users FROM anon, authenticated;

GRANT SELECT (
  id, username, name, role, role_id, branch_id, active, created_at,
  email, auth_user_id
) ON public.users TO anon, authenticated;
