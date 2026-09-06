-- Gating de módulos por plan de renta (ver conversación con el dueño del
-- proyecto, 2026-09-05). Catálogo de planes/módulos vive en código
-- (supabase/functions/_shared/plans.ts), no aquí -- esta columna solo guarda
-- qué plan tiene cada tenant.
--
-- Default 'multisucursal' (el plan con TODOS los módulos) a propósito: hay
-- al menos un tenant real (Tenant 1, $1500/mes, "acceso a todos los módulos
-- y actualizaciones") vendido antes de que este sistema existiera -- el
-- default asegura que ninguna fila existente pierda acceso a algo que ya se
-- le vendió como incluido. Los tenants nuevos (self-serve y alta manual)
-- mandan su plan_id explícito desde las Edge Functions correspondientes.
alter table public.tenants
  add column plan_id text not null default 'multisucursal';

alter table public.tenants
  add constraint tenants_plan_id_check
  check (plan_id in ('esencial', 'operacion_completa', 'multisucursal'));
