-- Referencia única de pago por tenant (concepto de transferencia bancaria,
-- ver conversación con el dueño del proyecto, 2026-09-05). Formato
-- WH-{ABREVIATURA}-{id}, calculado en código (self-serve-onboard/
-- onboard-tenant, ver _shared/billing.ts::buildPaymentReference).
--
-- SIN NOT NULL a propósito: el id del tenant (parte de la fórmula) recién
-- se conoce DESPUÉS del insert, así que el código hace insert y luego un
-- segundo update con la referencia -- una ventana donde la columna es NULL
-- por diseño, no un descuido. UNIQUE sí aplica (Postgres permite varios
-- NULL bajo UNIQUE, no bloquea esa ventana).
--
-- Backfill con la misma fórmula para tenants existentes (incluido Tenant 1)
-- -- así ningún cliente vendido antes de esto se queda sin una referencia
-- identificable en el estado de cuenta.
alter table public.tenants
  add column payment_reference text;

update public.tenants
set payment_reference = 'WH-' || upper(left(regexp_replace(name, '[^a-zA-Z]', '', 'g'), 4)) || '-' || lpad(id::text, 4, '0')
where payment_reference is null;

alter table public.tenants
  add constraint tenants_payment_reference_unique unique (payment_reference);
