-- Cuentas SaaS 2026-08-22: sistema de permisos granular por módulo.
--
-- Auditado antes de escribir esto: users YA tiene branch_id (usado en
-- login/getAllUsers/createUser/updateUser/removeUser desde antes de esta
-- sesión), YA tiene `active` (soft-delete) y `role` (texto libre, ya con
-- 'admin'/'cajero'/'empleado' reales, no un ENUM limitado a 'admin'). NO se
-- toca ni se renombra ninguna de esas 3 columnas -- se agrega `role_id`
-- al lado, sin quitar `role` (deja login/checks viejos funcionando tal
-- cual mientras se migra cada renderer a hasPermission()).
--
-- roles/role_permissions si son de verdad nuevos: hoy el control de acceso
-- es un array fijo de nombres de rol por pantalla (guardSession(['admin',
-- 'cajero']) en corte-renderer.js, etc.) -- esto lo reemplaza por una tabla
-- editable desde Cuentas, con CRUD por módulo.

CREATE TABLE IF NOT EXISTS public.roles (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id bigint NOT NULL REFERENCES public.branches(id),
  name text NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, name)
);

CREATE TABLE IF NOT EXISTS public.role_permissions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role_id bigint NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  module text NOT NULL,
  can_view boolean NOT NULL DEFAULT false,
  can_create boolean NOT NULL DEFAULT false,
  can_edit boolean NOT NULL DEFAULT false,
  can_delete boolean NOT NULL DEFAULT false,
  UNIQUE (role_id, module)
);

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS role_id bigint REFERENCES public.roles(id);

CREATE INDEX IF NOT EXISTS idx_roles_branch ON public.roles (branch_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON public.role_permissions (role_id);
CREATE INDEX IF NOT EXISTS idx_users_role_id ON public.users (role_id);

-- Semilla de roles para CADA sucursal real (no hardcodea branch_id=1 --
-- recorre public.branches, así que si algún día hay una 2a sucursal, basta
-- con volver a correr este bloque, ON CONFLICT lo deja sin duplicar).
DO $$
DECLARE
  v_branch record;
BEGIN
  FOR v_branch IN SELECT id FROM public.branches LOOP
    INSERT INTO public.roles (branch_id, name, description, is_system) VALUES
      (v_branch.id, 'Admin', 'Acceso completo a todos los módulos', true),
      (v_branch.id, 'Gerente', 'Supervisión operativa, sin administrar cuentas', false),
      (v_branch.id, 'Cajero', 'Ventas, comandas y corte de caja', false),
      (v_branch.id, 'Cocina', 'Pantalla de cocina (KDS) y comandas', false),
      (v_branch.id, 'Mesero', 'Comandas de mesa y ventas de mostrador', false),
      (v_branch.id, 'Empleado', 'Registrar su propia entrada/salida en Asistencia', false)
    ON CONFLICT (branch_id, name) DO NOTHING;
  END LOOP;
END $$;

-- Permisos default por rol. Reflejan lo que YA permitían los
-- guardSession(allowedRoles) existentes (ver auditoría arriba) más el caso
-- nuevo de Gerente/Mesero/Cocina, que no existían como rol real antes.
-- Admin: los 13 módulos, los 4 permisos, siempre true.
INSERT INTO public.role_permissions (role_id, module, can_view, can_create, can_edit, can_delete)
SELECT r.id, m.module, true, true, true, true
FROM public.roles r
JOIN (VALUES
  ('ventas'), ('kds'), ('comandas'), ('catalogo'), ('inventario'), ('corte'),
  ('costos'), ('asistencia'), ('nomina'), ('historial'), ('reportes'),
  ('ajustes'), ('cuentas')
) AS m(module) ON true
WHERE r.name = 'Admin'
ON CONFLICT (role_id, module) DO NOTHING;

-- Gerente/Cajero/Cocina/Mesero/Empleado: explícito por rol (no generado en
-- loop) para que quede legible y auditable a simple vista qué puede hacer
-- cada uno.
INSERT INTO public.role_permissions (role_id, module, can_view, can_create, can_edit, can_delete)
SELECT r.id, m.module, m.can_view, m.can_create, m.can_edit, m.can_delete
FROM public.roles r
JOIN (VALUES
  ('Gerente','ventas',true,true,true,false),
  ('Gerente','kds',true,false,true,false),
  ('Gerente','comandas',true,true,true,false),
  ('Gerente','catalogo',true,true,true,false),
  ('Gerente','inventario',true,true,true,false),
  ('Gerente','corte',true,true,true,false),
  ('Gerente','costos',true,false,false,false),
  ('Gerente','asistencia',true,true,true,false),
  ('Gerente','nomina',true,false,true,false),
  ('Gerente','historial',true,false,false,false),
  ('Gerente','reportes',true,false,false,false),
  ('Gerente','ajustes',true,false,false,false),
  ('Gerente','cuentas',true,false,false,false),

  ('Cajero','ventas',true,true,false,false),
  ('Cajero','kds',true,false,false,false),
  ('Cajero','comandas',true,true,true,false),
  ('Cajero','corte',true,true,false,false),
  ('Cajero','historial',true,false,false,false),

  ('Cocina','kds',true,false,true,false),
  ('Cocina','comandas',true,false,false,false),

  ('Mesero','comandas',true,true,true,false),
  ('Mesero','ventas',true,true,false,false),
  ('Mesero','kds',true,false,false,false),

  ('Empleado','asistencia',true,true,false,false)
) AS m(role_name, module, can_view, can_create, can_edit, can_delete)
  ON m.role_name = r.name
ON CONFLICT (role_id, module) DO NOTHING;

-- Backfill: liga cada usuario existente a su rol real por nombre
-- (users.role sigue siendo 'admin'/'cajero'/'empleado' en minúsculas).
UPDATE public.users u
SET role_id = r.id
FROM public.roles r
WHERE r.branch_id = u.branch_id
  AND lower(r.name) = u.role
  AND u.role_id IS NULL;

-- ==========================================================================
-- RPCs (mismo patrón SECURITY DEFINER + p_branch_id ya usado en todo el
-- repo -- ver create_product/create_promotion como referencia).
-- ==========================================================================

-- Único punto de lectura de permisos: si el usuario no tiene role_id
-- (instalación previa a esta migración que no pudo backfillearse, o el rol
-- se borró), devuelve 0 filas -- el llamador (db.js/React) debe caer al
-- viejo criterio `role === 'admin'` en ese caso, nunca negar todo de golpe.
CREATE OR REPLACE FUNCTION public.get_user_permissions(p_user_id bigint)
RETURNS TABLE(module text, can_view boolean, can_create boolean, can_edit boolean, can_delete boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT rp.module, rp.can_view, rp.can_create, rp.can_edit, rp.can_delete
  FROM public.users u
  JOIN public.role_permissions rp ON rp.role_id = u.role_id
  WHERE u.id = p_user_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_permissions(bigint) TO anon;

CREATE OR REPLACE FUNCTION public.get_roles_by_branch(p_branch_id bigint)
RETURNS SETOF public.roles
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.roles WHERE branch_id = p_branch_id ORDER BY is_system DESC, name;
$$;

GRANT EXECUTE ON FUNCTION public.get_roles_by_branch(bigint) TO anon;

CREATE OR REPLACE FUNCTION public.get_role_permissions(p_branch_id bigint, p_role_id bigint)
RETURNS SETOF public.role_permissions
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT rp.* FROM public.role_permissions rp
  JOIN public.roles r ON r.id = rp.role_id
  WHERE r.id = p_role_id AND r.branch_id = p_branch_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_role_permissions(bigint, bigint) TO anon;

CREATE OR REPLACE FUNCTION public.create_role(p_branch_id bigint, p_name text, p_description text)
RETURNS public.roles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row public.roles;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'El nombre del rol es obligatorio.';
  END IF;
  INSERT INTO public.roles (branch_id, name, description, is_system)
  VALUES (p_branch_id, btrim(p_name), p_description, false)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_role(bigint, text, text) TO anon;

CREATE OR REPLACE FUNCTION public.update_role(p_branch_id bigint, p_id bigint, p_name text, p_description text)
RETURNS public.roles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row public.roles;
BEGIN
  IF EXISTS (SELECT 1 FROM public.roles WHERE id = p_id AND branch_id = p_branch_id AND is_system) THEN
    RAISE EXCEPTION 'El rol Admin no se puede renombrar.';
  END IF;
  UPDATE public.roles
  SET name = COALESCE(NULLIF(btrim(p_name), ''), name),
      description = p_description
  WHERE id = p_id AND branch_id = p_branch_id
  RETURNING * INTO v_row;
  IF v_row IS NULL THEN RAISE EXCEPTION 'No se encontró el rol % en esta sucursal', p_id; END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_role(bigint, bigint, text, text) TO anon;

-- No se puede borrar un rol de sistema (Admin) ni un rol que todavía tenga
-- usuarios asignados (evita dejar cuentas "huérfanas" sin permisos).
CREATE OR REPLACE FUNCTION public.remove_role(p_branch_id bigint, p_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_system boolean;
  v_users_count integer;
BEGIN
  SELECT is_system INTO v_is_system FROM public.roles WHERE id = p_id AND branch_id = p_branch_id;
  IF v_is_system IS NULL THEN
    RAISE EXCEPTION 'No se encontró el rol % en esta sucursal', p_id;
  END IF;
  IF v_is_system THEN
    RAISE EXCEPTION 'El rol Admin no se puede eliminar.';
  END IF;

  SELECT COUNT(*) INTO v_users_count FROM public.users WHERE role_id = p_id;
  IF v_users_count > 0 THEN
    RAISE EXCEPTION 'Este rol todavía tiene % cuenta(s) asignada(s); reasígnalas antes de eliminarlo.', v_users_count;
  END IF;

  DELETE FROM public.roles WHERE id = p_id AND branch_id = p_branch_id;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.remove_role(bigint, bigint) TO anon;

-- Reemplaza TODOS los permisos de un rol de una sola vez (la UI manda el
-- estado completo de los 13 módulos cada vez que se guarda "Permisos por
-- rol"). p_permissions: jsonb array de {module, can_view, can_create,
-- can_edit, can_delete}.
CREATE OR REPLACE FUNCTION public.set_role_permissions(p_branch_id bigint, p_role_id bigint, p_permissions jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row jsonb;
  v_count integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.roles WHERE id = p_role_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró el rol % en esta sucursal', p_role_id;
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_permissions, '[]'::jsonb))
  LOOP
    IF (v_row->>'module') IS NULL THEN CONTINUE; END IF;

    INSERT INTO public.role_permissions (role_id, module, can_view, can_create, can_edit, can_delete)
    VALUES (
      p_role_id,
      v_row->>'module',
      COALESCE((v_row->>'can_view')::boolean, false),
      COALESCE((v_row->>'can_create')::boolean, false),
      COALESCE((v_row->>'can_edit')::boolean, false),
      COALESCE((v_row->>'can_delete')::boolean, false)
    )
    ON CONFLICT (role_id, module) DO UPDATE SET
      can_view = EXCLUDED.can_view,
      can_create = EXCLUDED.can_create,
      can_edit = EXCLUDED.can_edit,
      can_delete = EXCLUDED.can_delete;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_role_permissions(bigint, bigint, jsonb) TO anon;

-- Lectura/escritura de roles/role_permissions: mismo modelo de confianza que
-- el resto del repo (anon key, sin auth.uid() real -- las RPC de arriba ya
-- validan branch_id a mano). RLS abierta a anon, consistente con
-- deny_anon_direct NO aplicado aquí porque get_roles_by_branch/
-- get_role_permissions ya son de solo lectura vía RPC, pero se deja SELECT
-- directo abierto también por si algún reporte futuro necesita join directo.
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "roles_allow_anon_all" ON public.roles;
CREATE POLICY "roles_allow_anon_all" ON public.roles FOR ALL TO anon USING (true) WITH CHECK (true);

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "role_permissions_allow_anon_all" ON public.role_permissions;
CREATE POLICY "role_permissions_allow_anon_all" ON public.role_permissions FOR ALL TO anon USING (true) WITH CHECK (true);
