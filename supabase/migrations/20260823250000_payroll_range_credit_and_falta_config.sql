-- Bug reproducido en vivo (2026-08-23, empleado "EMPLEADO PRUEBA" id 10,
-- branch_id 1): la columna "Crédito Semanal" de Nómina mostraba $0 pese a
-- una venta real con $54 de excedente a crédito (sale id 16, folio, total
-- $77, employee_benefit_before/after 23/0, payment_method
-- 'credito_nomina'). Confirmado con pg_get_functiondef + lectura directa de
-- employee_weekly_credit vía RPC autenticado real, no adivinado.
--
-- Causa raíz: employee_weekly_credit (donde process_sale acumula el
-- crédito) se agrupa por `date_trunc('week', v_today)` -- semana ISO
-- lunes-domingo, fija, sin importar el día de pago configurado. La pantalla
-- de Nómina, en cambio, muestra una "semana laboral" ANCLADA al día de pago
-- configurable (getWeekRange en db.js -- p.ej. domingo-sábado si el pago es
-- sábado) y traducía esa semana visible a su semana ISO con
-- `isoMondayOf(weekEnd)` para poder consultar employee_weekly_credit.
--
-- Esa traducción asume que TODA la semana visible cae dentro de la misma
-- semana ISO que contiene weekEnd -- falso en cuanto el día de pago no es
-- domingo: con payday=sábado la semana visible es domingo-sábado, pero ese
-- domingo inicial es el ÚLTIMO día de la semana ISO ANTERIOR, no de la que
-- contiene el sábado (weekEnd). Reproducido en vivo: venta hecha el domingo
-- 2026-08-23 -> process_sale la guardó bajo week_start=2026-08-17 (lunes,
-- semana ISO real); la pantalla, viendo la semana domingo 23 a sábado 29,
-- consultaba get_payroll_week_credit con week_start=2026-08-24 (isoMondayOf
-- del sábado 29) -- semana ISO distinta, cero filas, "$0" en pantalla.
--
-- employee_weekly_credit es una tabla PRE-AGREGADA por semana (no por día),
-- así que no se puede "sumar las dos semanas ISO que se traslapan con la
-- semana visible" sin contar de más (cada agregado ISO trae días fuera del
-- rango visible). La fuente con granularidad real por día es
-- employee_consumption.consumption_date -- pero esa tabla tiene RLS sin
-- policy anon/authenticated (ver comentario ya existente en
-- getEmployeeDailyConsumption/db.js), así que no es legible directo desde
-- el cliente. Esta RPC (SECURITY DEFINER, mismo patrón que
-- get_payroll_week_credit) la resume filtrando por el rango de fechas
-- EXACTO que ya se muestra en pantalla -- sin bucket de semana de por
-- medio, inmune a cualquier desfase entre el día de pago configurado y una
-- semana ISO. get_payroll_week_credit/employee_weekly_credit NO se tocan
-- (process_sale los sigue alimentando igual, sin cambios, cero riesgo de
-- migración de datos) -- simplemente Nómina deja de depender de ellos para
-- este número y usa esta RPC en su lugar.
CREATE FUNCTION public.get_payroll_range_credit(p_branch_id bigint, p_date_from date, p_date_to date)
 RETURNS TABLE(employee_id bigint, credit_amount numeric, paid_amount numeric)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (p_branch_id = ANY (COALESCE(public.current_visible_branch_ids(), ARRAY[]::bigint[]))) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  RETURN QUERY
  SELECT ec.employee_id,
         GREATEST(COALESCE(SUM(ec.total_amount - ec.benefit_amount - ec.employee_paid), 0), 0) AS credit_amount,
         COALESCE(SUM(ec.employee_paid), 0) AS paid_amount
  FROM public.employee_consumption ec
  WHERE ec.branch_id = p_branch_id
    AND ec.consumption_date BETWEEN p_date_from AND p_date_to
  GROUP BY ec.employee_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_payroll_range_credit(bigint, date, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_payroll_range_credit(bigint, date, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_payroll_range_credit(bigint, date, date) TO authenticated;
