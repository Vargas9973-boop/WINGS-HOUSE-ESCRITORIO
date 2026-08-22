-- Scaffolding de "tenant" arriba de sucursal (Punto 1 del audit SaaS).
--
-- QUÉ ES esto: hoy `branches` no tiene ningún dueño -- todas las sucursales
-- cuelgan directo del mismo proyecto de Supabase, sin forma de decir "estas
-- 3 sucursales son del negocio A, estas otras 2 son del negocio B". Esta
-- migración agrega esa capa como ESTRUCTURA, sin romper nada: crea
-- `tenants`, la puebla con un único registro (el negocio actual, Wings
-- House), y le asigna ese tenant a todas las sucursales existentes.
--
-- QUÉ NO ES: esto NO aísla nada todavía. `tenant_id` no está referenciado
-- por ninguna policy de RLS ni por ningún RPC -- exactamente el mismo
-- estado en el que nació `branch_id` antes de que se empezara a exigir en
-- cada RPC (ver 20260820020000_rpc_branch_id_core_sales.sql en adelante) y
-- mucho antes de que las policies dejaran de ser `USING (true)`. Aislar de
-- verdad por tenant requiere primero una sesión verificable por Postgres
-- (JWT real / Supabase Auth), porque hoy ni siquiera `branch_id` está
-- aplicado a nivel de RLS (todas las policies de anon son permisivas) --
-- ver el punto 2 del mismo audit. Agregar tenant_id sin eso sería repetir
-- el mismo aislamiento "de mentira" un nivel más arriba.
--
-- Por qué SIN DEFAULT en branches.tenant_id: mismo criterio que
-- 20260820900000_drop_branch_default_RUN_LAST.sql aplicó a branch_id -- un
-- DEFAULT deja que un INSERT sin tenant_id explícito pase silenciosamente
-- y termine en el tenant equivocado (o en el único que existe hoy) sin que
-- nadie lo note. Mejor que falle en seco hasta que el código que crea
-- sucursales sepa a qué tenant pertenecen.

CREATE TABLE public.tenants (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  slug text UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tenants IS
  'Scaffolding de multi-tenencia (20260822110000). Sin RLS que lo use todavía -- ver comentario de la migración.';

INSERT INTO public.tenants (name, slug)
VALUES ('Wings House', 'wings-house');

ALTER TABLE public.branches ADD COLUMN tenant_id bigint REFERENCES public.tenants(id);

UPDATE public.branches
SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'wings-house');

ALTER TABLE public.branches ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX branches_tenant_id_idx ON public.branches(tenant_id);

-- RLS igual de permisiva que el resto de la base hoy (ver punto 2 del
-- audit) -- se activa por consistencia con las demás tablas, no porque
-- ya esté aplicando aislamiento real.
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY allow_anon_all ON public.tenants FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
