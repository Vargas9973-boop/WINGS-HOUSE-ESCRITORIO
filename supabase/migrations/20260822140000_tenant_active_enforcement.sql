-- Punto 1 + punto 2 del audit SaaS, cruzados: enforcement real de
-- tenant_id sin cambiar el acceso actual de nadie.
--
-- Se descartó la opción obvia (cada policy compara branch_id contra el
-- tenant_id del branch, además de contra current_branch_id()) porque es un
-- no-op: current_branch_id() YA sale de users.branch_id, y el tenant_id de
-- ESE mismo branch_id es, por construcción, el propio tenant del usuario --
-- estaría comparando algo contra sí mismo. Los FK ya garantizan que
-- users.branch_id -> branches.id -> branches.tenant_id (NOT NULL) nunca
-- puede quedar huérfano, así que no hay nada nuevo que verificar ahí.
--
-- Lo que SÍ es real: tenants.active. Hoy nada lo usa -- un tenant
-- "desactivado" no tiene ningún efecto. Se liga current_branch_id() (la
-- función de la que dependen las ~28 policies de fase 1 y fase 1b) a que
-- el tenant del usuario esté activo. Esto no cambia nada visible hoy (el
-- único tenant real, Wings House, está active=true) pero deja un
-- kill-switch real: el día que exista facturación/suspensión de cuentas,
-- desactivar un tenant corta TODO su acceso de inmediato, sin tocar
-- ninguna policy individual -- todas dependen de este único punto.
--
-- get_kds_orders también se actualiza (el único RPC anon-callable que lee
-- `sales` directo) para que el kill-switch aplique incluso ahí -- si no,
-- un tenant suspendido seguiría viendo su TV de cocina funcionando.

CREATE OR REPLACE FUNCTION public.current_branch_id()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.branch_id
  FROM public.users u
  JOIN public.branches b ON b.id = u.branch_id
  JOIN public.tenants t ON t.id = b.tenant_id
  WHERE u.auth_user_id = auth.uid()
    AND t.active = true;
$$;

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
  SELECT s.id, s.table_number, s.client_type, s.folio, s.status, s.created_at,
         s.kds_status, s.kds_started_at, s.kds_ready_at, s.is_delivery,
         s.delivery_fee, s.driver_name, s.total
  FROM public.sales s
  JOIN public.branches b ON b.id = s.branch_id
  JOIN public.tenants t ON t.id = b.tenant_id
  WHERE s.branch_id = p_branch_id
    AND t.active = true
    AND s.kds_status IS DISTINCT FROM 'entregada'
    AND s.status IS DISTINCT FROM 'cancelada'
  ORDER BY s.created_at ASC;
$$;
