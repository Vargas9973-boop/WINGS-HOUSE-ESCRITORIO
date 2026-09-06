-- Cobranza automática (ver conversación con el dueño del proyecto,
-- 2026-09-05): si el SuperAdmin no registra el pago a mano ("Marcar como
-- pagado"/"Validar pago", que empujan next_due_date a futuro), el tenant
-- avanza solo por 3 etapas relativas a next_due_date -- ejemplo dado:
--   05 sep (next_due_date)      -> vence, sigue 'active'.
--   06-08 sep (+1 a +3 días)    -> 'past_due' (período de gracia, sigue
--                                  operando -- solo aviso).
--   09 sep en adelante (+4 días+) -> 'suspended' + active=false (deja de
--                                  operar, ver
--                                  20260822140000_tenant_active_enforcement.sql).
--
-- Puramente derivado de next_due_date vs hoy, sin estado intermedio que
-- persistir aparte -- idempotente, y se autocorrige solo en cuanto
-- next_due_date se mueve a futuro (pago registrado). Si el operador
-- reactiva a mano (toggleActive) SIN registrar el pago (sin mover
-- next_due_date), esta función lo vuelve a suspender en la siguiente
-- corrida -- a propósito, es justo el comportamiento pedido.
--
-- No aplica a 'pending' (alta self-serve esperando su primer pago, ver
-- self-serve-onboard -- otro flujo, "Validar pago"), 'trial' (periodo de
-- prueba), ni billing_type != 'monthly' (licencia/lifetime no tienen ciclo
-- recurrente que vencer). Tampoco toca a quien YA esté 'suspended' -- evita
-- que esta función reescriba a 'past_due' (con active sin cambiar) a un
-- tenant que el operador suspendió a mano por otro motivo (ej. abuso) y que
-- de casualidad también tiene next_due_date vencido; reactivar a un
-- 'suspended' siempre queda en manos de "Activar"/"Marcar como
-- pagado"/"Validar pago", nunca de este proceso.
create or replace function public.auto_update_billing_status()
returns void
language sql
security definer
set search_path = public
as $$
  update public.tenants
  set
    billing_status = case
      when (current_date - next_due_date) >= 4 then 'suspended'
      else 'past_due'
    end,
    active = case
      when (current_date - next_due_date) >= 4 then false
      else active
    end
  where billing_type = 'monthly'
    and billing_status not in ('pending', 'trial', 'suspended')
    and next_due_date is not null
    and next_due_date < current_date;
$$;

comment on function public.auto_update_billing_status() is
  'Cobranza automática diaria: past_due a partir de 1 día vencido, suspended a partir de 4 -- ver migración para el detalle completo.';

create extension if not exists pg_cron;

select cron.schedule(
  'auto-update-billing-status',
  '0 8 * * *', -- 08:00 UTC = 02:00 CDMX (fuera de horario de operación)
  $$ select public.auto_update_billing_status(); $$
);

-- Reconciliación inmediata: cualquier tenant que ya esté vencido hoy (antes
-- de que exista este proceso) queda al día con la regla de arriba de una
-- vez, en vez de esperar a la corrida de mañana.
select public.auto_update_billing_status();
