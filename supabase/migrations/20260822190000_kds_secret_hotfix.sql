-- Fase 1 (hotfix quirúrgico) del audit multi-tenant, punto "get_kds_orders":
-- KDS corre "sin login" (ver comentario en main.js línea ~36 y db.js línea
-- ~1268) en instalaciones dedicadas (TV de cocina, PC sin cajero que inicie
-- sesión nunca). Esa instalación queda anon para siempre -- no hay sesión
-- de Supabase Auth que la vuelva `authenticated`.
--
-- Dos huecos reales encontrados (no el que se asumió al principio):
--   1. La función `get_kds_orders(p_branch_id)` que ya existía (creada en
--      20260822140000_tenant_active_enforcement.sql) es codigo MUERTO --
--      db.js::getKdsOrders() nunca la llama, sigue leyendo `sales` directo
--      vía supabase.from('sales').select(...). Confirmado con grep
--      exhaustivo (cero referencias a "kds_orders"/"kdsOrders" como RPC en
--      todo el repo JS). Aun así, sigue siendo un hueco real: cualquiera
--      con la anon key puede llamarla hoy por REST con cualquier
--      branch_id y ver folios/totales/repartidor de otro tenant.
--   2. El path que SÍ usa la app real (lectura directa de `sales` como
--      anon) quedó roto o abierto según el caso desde
--      20260822120000_rls_restrictive_phase1.sql: esa migración cerró el
--      SELECT de `sales` a `authenticated` únicamente. Una instalación de
--      KDS-sin-login que siga en producción hoy probablemente ve la
--      pantalla vacía (RLS bloqueando el read), no un leak -- pero es
--      exactamente el mismo problema de fondo: nadie derivaba branch_id de
--      una sesión real para este caso.
--
-- Fix: un secreto por sucursal, no adivinable (a diferencia de branch_id,
-- bigint secuencial), guardado en una tabla aparte SIN ninguna policy de
-- RLS (deny-by-default total -- ni siquiera SELECT para authenticated) --
-- la única forma de tocarla es una función SECURITY DEFINER. db.js pasa a
-- llamar la RPC con ese secreto en vez de leer `sales` directo. El secreto
-- vive en branch-config.json (mismo archivo/patrón que branchId, ver
-- comentario en main.js línea ~82) y se instala a mano una vez por PC de
-- KDS -- no hay onboarding automático todavía (ver Fase 2/3 del audit
-- SaaS), así que no tiene caso automatizar la distribución del secreto.
--
-- Esto es explícitamente el hotfix de HOY, no el modelo final: cuando
-- exista el archivo de licencia .wings firmado (tenant_id + branch_id +
-- expiración), ese archivo reemplaza a branch-config.json + este secreto
-- como fuente de verdad local, y esta función se vuelve a tocar.

-- ==========================================================================
-- 1. Tabla del secreto -- RLS on, CERO policies (ni para authenticated).
--    SECURITY DEFINER bypasea RLS igual, así que esto no afecta a las
--    funciones de abajo -- solo bloquea cualquier lectura directa
--    (supabase.from('branch_kds_secrets')...) que alguien intente agregar
--    después por error.
-- ==========================================================================
CREATE TABLE public.branch_kds_secrets (
  branch_id bigint PRIMARY KEY REFERENCES public.branches(id),
  secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.branch_kds_secrets ENABLE ROW LEVEL SECURITY;

-- Backfill: un secreto por cada sucursal ya existente. Dos gen_random_uuid()
-- concatenados (sin guiones) en vez de gen_random_bytes()/pgcrypto -- así
-- no depende de que la extensión esté instalada en el search_path de la
-- función (gen_random_uuid() es de pg_catalog, siempre disponible desde
-- PG13). ~244 bits de entropía, de sobra para esto.
INSERT INTO public.branch_kds_secrets (branch_id, secret)
SELECT b.id, replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
FROM public.branches b;

-- ==========================================================================
-- 2. get_kds_orders: reemplaza la versión de un solo parámetro (código
--    muerto, nunca llamado desde JS) por una que exige el secreto. DROP
--    explícito primero -- agregar un parámetro vía CREATE OR REPLACE deja
--    un overload duplicado vivo en vez de reemplazar (ver
--    [[postgres-create-or-replace-overload-trap]]).
-- ==========================================================================
DROP FUNCTION IF EXISTS public.get_kds_orders(bigint);

CREATE FUNCTION public.get_kds_orders(p_branch_id bigint, p_kds_secret text)
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
  JOIN public.branch_kds_secrets k ON k.branch_id = b.id
  WHERE s.branch_id = p_branch_id
    AND p_kds_secret IS NOT NULL
    AND k.secret = p_kds_secret
    AND t.active = true
    AND s.kds_status IS DISTINCT FROM 'entregada'
    AND s.status IS DISTINCT FROM 'cancelada'
  ORDER BY s.created_at ASC;
$$;

-- Sigue siendo callable por anon a propósito (el caso real: TV de cocina
-- sin sesión) -- lo que cambia es que ya no basta con adivinar un
-- branch_id, hace falta el secreto de esa sucursal. authenticated también
-- puede llamarla (caso: KDS abierto en el mismo proceso que un cajero ya
-- logueado) -- inofensivo, mismo secreto requerido.
GRANT EXECUTE ON FUNCTION public.get_kds_orders(bigint, text) TO anon, authenticated;

-- ==========================================================================
-- 3. get_branch_kds_secret: para que un admin YA logueado (sesión real)
--    pueda recuperar el secreto de SU sucursal y copiarlo a mano a
--    branch-config.json del PC de KDS -- authenticated-only, valida contra
--    current_visible_branch_ids() (mismo mecanismo que ya usan las ~28
--    policies de fase 1, respeta el rol dueño multi-sucursal). Sin UI
--    todavía -- se llama por ahora vía el SQL editor de Supabase o una
--    consola con sesión válida.
-- ==========================================================================
CREATE FUNCTION public.get_branch_kds_secret(p_branch_id bigint)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_secret text;
BEGIN
  IF NOT (p_branch_id = ANY (public.current_visible_branch_ids())) THEN
    RAISE EXCEPTION 'No tienes acceso a esa sucursal.';
  END IF;

  SELECT secret INTO v_secret FROM public.branch_kds_secrets WHERE branch_id = p_branch_id;
  RETURN v_secret;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_branch_kds_secret(bigint) TO authenticated;
