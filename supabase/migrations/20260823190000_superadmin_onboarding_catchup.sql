-- Captura del esquema del panel SuperAdmin (wing-house-web/src/pages/admin/),
-- aplicado en producción como parte del desarrollo de ese panel pero nunca
-- comiteado como migración en este repo (mismo patrón de drift ya
-- encontrado varias veces en esta serie de auditorías -- ver
-- 20260823130000_denormalize_branch_id_catchup.sql). DDL idempotente: en la
-- base viva no debería cambiar nada (todo ya existe), solo deja de faltar
-- en un ambiente nuevo (`supabase db reset` / staging).
--
-- Verificado en vivo antes de escribir esto (pg_get_functiondef/
-- information_schema, mismo método que el resto de esta serie): columnas
-- de billing en tenants, columnas de address/city/phone en branches,
-- branch_kds_secrets, y las 4 funciones is_superadmin/admin_create_branch/
-- admin_tenant_detail/admin_branch_kds_secret ya viven en
-- acvsmyvijzqredqmoxti tal cual quedan reconstruidas abajo.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS contact_email text,
  ADD COLUMN IF NOT EXISTS contact_phone text,
  ADD COLUMN IF NOT EXISTS price numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency text DEFAULT 'MXN',
  ADD COLUMN IF NOT EXISTS billing_type text DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS billing_status text DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS next_due_date date,
  ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS phone text;

CREATE TABLE IF NOT EXISTS public.branch_kds_secrets (
  branch_id bigint NOT NULL REFERENCES public.branches(id),
  secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id)
);

-- RLS habilitada, sin ninguna policy a propósito -- deniega todo a
-- anon/authenticated por defecto; solo accesible vía las funciones
-- SECURITY DEFINER de arriba/get_branch_kds_secret (KDS hotfix).
ALTER TABLE public.branch_kds_secrets ENABLE ROW LEVEL SECURITY;

-- is_superadmin(): identidad hardcodeada a propósito (single operador hoy,
-- no una tabla de roles) -- comparar contra tabla habría sido sobre-
-- ingeniería para un solo dueño de plataforma.
CREATE OR REPLACE FUNCTION public.is_superadmin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(auth.jwt() ->> 'email', '') = 'vargas9973@gmail.com';
$function$;

-- GRANT a PUBLIC (no solo authenticated) a propósito, igual que en vivo:
-- llamarla como anon simplemente evalúa a false (auth.jwt() vacío), sin
-- filtrar nada -- no hace falta restringir el EXECUTE en sí, el guard real
-- vive en el cuerpo de cada función que la usa.
GRANT EXECUTE ON FUNCTION public.is_superadmin() TO PUBLIC;

CREATE OR REPLACE FUNCTION public.admin_create_branch(p_tenant_id bigint, p_name text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_branch public.branches;
BEGIN
  IF NOT public.is_superadmin() THEN
    RAISE EXCEPTION 'No autorizado.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'Tenant % no existe.', p_tenant_id;
  END IF;

  INSERT INTO public.branches (tenant_id, name)
  VALUES (p_tenant_id, p_name)
  RETURNING * INTO v_branch;

  RETURN row_to_json(v_branch);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_create_branch(bigint, text) TO PUBLIC;

CREATE OR REPLACE FUNCTION public.admin_tenant_detail(p_tenant_id bigint)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result json;
BEGIN
  IF NOT public.is_superadmin() THEN
    RAISE EXCEPTION 'No autorizado.';
  END IF;

  SELECT json_build_object(
    'branches', COALESCE((
      SELECT json_agg(json_build_object(
        'id', b.id,
        'name', b.name,
        'city', b.city,
        'created_at', b.created_at,
        'business_name', (
          SELECT s.value FROM public.settings s
          WHERE s.branch_id = b.id AND s.key = 'business_name'
        )
      ) ORDER BY b.id)
      FROM public.branches b
      WHERE b.tenant_id = p_tenant_id
    ), '[]'::json),
    'users', COALESCE((
      SELECT json_agg(json_build_object(
        'id', u.id,
        'username', u.username,
        'name', u.name,
        'role', u.role,
        'active', u.active,
        'branch_id', u.branch_id
      ) ORDER BY u.id)
      FROM public.users u
      JOIN public.branches b ON b.id = u.branch_id
      WHERE b.tenant_id = p_tenant_id
    ), '[]'::json),
    'total_billed', COALESCE((
      SELECT SUM(s.total)
      FROM public.sales s
      JOIN public.branches b ON b.id = s.branch_id
      WHERE b.tenant_id = p_tenant_id
    ), 0)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_tenant_detail(bigint) TO PUBLIC;

CREATE OR REPLACE FUNCTION public.admin_branch_kds_secret(p_branch_id bigint)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_secret text;
BEGIN
  IF NOT public.is_superadmin() THEN
    RAISE EXCEPTION 'No autorizado.';
  END IF;

  SELECT secret INTO v_secret FROM public.branch_kds_secrets WHERE branch_id = p_branch_id;
  RETURN v_secret;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_branch_kds_secret(bigint) TO PUBLIC;

-- RLS de tenants: reemplaza el allow_anon_all original (scaffolding inicial,
-- 20260822110000) por acceso exclusivo al superadmin en las 4 operaciones.
DROP POLICY IF EXISTS allow_anon_all ON public.tenants;
DROP POLICY IF EXISTS tenants_superadmin_select ON public.tenants;
DROP POLICY IF EXISTS tenants_superadmin_insert ON public.tenants;
DROP POLICY IF EXISTS tenants_superadmin_update ON public.tenants;
DROP POLICY IF EXISTS tenants_superadmin_delete ON public.tenants;

CREATE POLICY tenants_superadmin_select ON public.tenants
  FOR SELECT USING (public.is_superadmin());
CREATE POLICY tenants_superadmin_insert ON public.tenants
  FOR INSERT WITH CHECK (public.is_superadmin());
CREATE POLICY tenants_superadmin_update ON public.tenants
  FOR UPDATE USING (public.is_superadmin()) WITH CHECK (public.is_superadmin());
CREATE POLICY tenants_superadmin_delete ON public.tenants
  FOR DELETE USING (public.is_superadmin());
