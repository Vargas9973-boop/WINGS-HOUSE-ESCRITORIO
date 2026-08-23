-- Auditoría final de asistencia/nómina/empleados: los 6 RPC "caja negra"
-- que quedaron fuera de Fase 2A/2B/2C (20260822240000/310000/340000).
-- Confirmado con pg_get_functiondef en vivo (no adivinado):
--
--   - update_employee, remove_employee, save_fingerprint, clear_fingerprint
--     -- YA tenían el guard de sesión completo desde Fase 2A/2B. Sin
--     cambios aquí.
--   - create_employee, register_attendance, set_payroll_bonus,
--     get_payroll_week_credit -- SÍ reciben p_branch_id en su firma viva
--     (alguien ya lo agregó del lado de la base en algún momento previo a
--     esta sesión), pero db.js NUNCA lo mandaba -- estas 4 llamadas están
--     rotas HOY (PostgREST no puede resolver la firma sin ese parámetro
--     requerido, sin default). Dar de alta un empleado, registrar
--     asistencia, acreditar el bono semanal y calcular el crédito de
--     nómina no funcionan en el .exe actual. Además, el único guard que sí
--     tenían era "p_branch_id IS NULL -> RAISE" -- NO validaba contra la
--     sesión, así que cualquiera con la anon key podía mandar CUALQUIER
--     branch_id y operar nómina/asistencia de otra sucursal. db.js ya se
--     corrigió en este mismo commit para mandar p_branch_id; aquí se
--     fortalece el guard a comparar contra la sesión real.
--   - get_sale_employee_breakdown, get_employee_daily_consumption -- NO
--     reciben p_branch_id en su firma (ni lo necesitan agregar -- ver
--     razón abajo) y hoy no validan sucursal en absoluto del lado del
--     servidor (get_employee_daily_consumption tenía un chequeo de
--     branch_id, pero solo en el cliente, en db.js -- fácil de saltarse
--     llamando el RPC directo).
--
-- Sobre "inferir branch_id desde auth.uid() -> employees -> branch_id del
-- empleado logueado" (la instrucción original de este punto): no es
-- implementable tal cual -- confirmado con information_schema.columns que
-- `employees` no tiene NINGUNA columna que la ligue a auth.uid() (ni
-- auth_user_id ni user_id). auth.uid() solo se resuelve contra
-- `users.auth_user_id` (ver current_branch_id(), 20260822120000). Además,
-- las pantallas que llaman estos 6 RPC (Asistencia, Nómina, RRHH) ya
-- exigen sesión real vía guardPermission() antes de cargar -- confirmado
-- en attendance-renderer.js línea 264. Es decir: quien llama SIEMPRE es un
-- usuario de `users` (cajero/admin operando la pantalla), nunca el
-- "empleado" en sí (los empleados no tienen cuenta de login, son personal
-- a quien se le paga/registra asistencia). El equivalente real y ya
-- probado en todo el resto de la Fase 2 es current_branch_id() -- misma
-- fuente, mismo mecanismo que ya usan las ~35 funciones anteriores.

-- ==========================================================================
-- 1. create_employee: agrega el guard real (antes solo "no nulo").
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.create_employee(p_branch_id bigint, p_name text, p_role text, p_salary numeric, p_weekly_bonus numeric, p_active boolean)
 RETURNS employees
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_employee public.employees;
BEGIN
    IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
        RAISE EXCEPTION 'branch mismatch';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch_id) THEN
        RAISE EXCEPTION 'La sucursal % no existe.', p_branch_id;
    END IF;

    INSERT INTO public.employees (
        branch_id, name, role, salary, weekly_bonus, active
    )
    VALUES (
        p_branch_id,
        p_name,
        COALESCE(NULLIF(p_role, ''), 'Personal'),
        COALESCE(p_salary, 0),
        COALESCE(p_weekly_bonus, 0),
        COALESCE(p_active, true)
    )
    RETURNING * INTO v_employee;

    RETURN v_employee;
END;
$function$;

-- ==========================================================================
-- 2. register_attendance
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.register_attendance(p_branch_id bigint, p_employee_id bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_last_type text;
  v_new_type text;
  v_row public.attendance%ROWTYPE;
  v_today date;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.employees
    WHERE id = p_employee_id AND branch_id = p_branch_id
  ) THEN
    RAISE EXCEPTION 'El empleado % no existe en la sucursal %', p_employee_id, p_branch_id;
  END IF;

  v_today := (now() AT TIME ZONE 'America/Mexico_City')::date;

  SELECT type INTO v_last_type FROM public.attendance
  WHERE employee_id = p_employee_id
    AND branch_id = p_branch_id
    AND ("timestamp" AT TIME ZONE 'America/Mexico_City')::date = v_today
  ORDER BY "timestamp" DESC LIMIT 1;

  v_new_type := CASE WHEN v_last_type = 'entrada' THEN 'salida' ELSE 'entrada' END;

  INSERT INTO public.attendance (employee_id, branch_id, type)
  VALUES (p_employee_id, p_branch_id, v_new_type)
  RETURNING * INTO v_row;

  RETURN row_to_json(v_row);
END;
$function$;

-- ==========================================================================
-- 3. set_payroll_bonus
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.set_payroll_bonus(p_branch_id bigint, p_employee_id bigint, p_week_start date, p_bonus_credited boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_emp public.employees%ROWTYPE;
    v_bonus numeric;
    v_total numeric;
BEGIN
    IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
        RAISE EXCEPTION 'branch mismatch';
    END IF;

    SELECT *
    INTO v_emp
    FROM public.employees
    WHERE id = p_employee_id
      AND branch_id = p_branch_id
      AND active = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Empleado no encontrado, inactivo, o no pertenece a esta sucursal.';
    END IF;

    v_bonus := CASE WHEN p_bonus_credited = true THEN COALESCE(v_emp.weekly_bonus, 0) ELSE 0 END;
    v_total := COALESCE(v_emp.salary, 0) + v_bonus;

    INSERT INTO public.payroll_weeks (
        branch_id, employee_id, employee_name, week_start, salary, bonus_credited, bonus_amount, total
    )
    VALUES (
        p_branch_id, p_employee_id, v_emp.name, p_week_start,
        COALESCE(v_emp.salary, 0), p_bonus_credited, v_bonus, v_total
    )
    ON CONFLICT (employee_id, week_start) DO UPDATE SET
        branch_id = EXCLUDED.branch_id,
        employee_name = EXCLUDED.employee_name,
        salary = EXCLUDED.salary,
        bonus_credited = EXCLUDED.bonus_credited,
        bonus_amount = EXCLUDED.bonus_amount,
        total = EXCLUDED.total,
        updated_at = now();
END;
$function$;

-- ==========================================================================
-- 4. get_payroll_week_credit (lectura -- current_visible_branch_ids() para
--    respetar el rol dueño, igual que el resto de las lecturas de Fase 2A).
--    LANGUAGE sql no soporta IF/RAISE, se convierte a plpgsql para poder
--    guardar (mismo criterio que 20260822260000).
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.get_payroll_week_credit(p_branch_id bigint, p_week_start date)
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
  SELECT ewc.employee_id,
         COALESCE(SUM(ewc.credit_amount), 0) AS credit_amount,
         COALESCE(SUM(ewc.paid_amount), 0) AS paid_amount
  FROM public.employee_weekly_credit ewc
  WHERE ewc.week_start = p_week_start
    AND ewc.branch_id = p_branch_id
  GROUP BY ewc.employee_id;
END;
$function$;

-- ==========================================================================
-- 5. get_sale_employee_breakdown: sin p_branch_id en la firma (no hace
--    falta agregarlo -- el sale_id ya identifica una sucursal concreta,
--    mismo patrón que liquidate_driver_sales/comanda_set_delivery en Fase
--    2A/2C). Se valida vía JOIN a sales.branch_id contra la sesión.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.get_sale_employee_breakdown(p_sale_id bigint)
 RETURNS json
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_benefit numeric := 0;
    v_paid numeric := 0;
    v_credit numeric := 0;
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM public.sales s
      WHERE s.id = p_sale_id AND s.branch_id = public.current_branch_id()
    ) THEN
        RAISE EXCEPTION 'No se encontró la venta % en esta sucursal', p_sale_id;
    END IF;

    SELECT
        COALESCE(SUM(benefit_amount), 0),
        COALESCE(SUM(employee_paid), 0),
        COALESCE(SUM(total_amount - benefit_amount - employee_paid), 0)
    INTO v_benefit, v_paid, v_credit
    FROM public.employee_consumption
    WHERE sale_id = p_sale_id;

    RETURN json_build_object(
        'benefit_amount', v_benefit,
        'employee_paid', v_paid,
        'credit_amount', GREATEST(v_credit, 0)
    );
END;
$function$;

-- ==========================================================================
-- 6. get_employee_daily_consumption: sin p_branch_id en la firma, mismo
--    criterio -- el employee_id ya identifica una sucursal concreta vía
--    employees.branch_id.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.get_employee_daily_consumption(p_employee_id bigint)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_total numeric;
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM public.employees e
      WHERE e.id = p_employee_id AND e.branch_id = public.current_branch_id()
    ) THEN
        RAISE EXCEPTION 'No se encontró el empleado % en esta sucursal', p_employee_id;
    END IF;

    SELECT COALESCE(SUM(benefit_amount), 0)
    INTO v_total
    FROM public.employee_consumption
    WHERE employee_id = p_employee_id
      AND consumption_date = (now() AT TIME ZONE 'America/Mexico_City')::date;

    RETURN v_total;
END;
$function$;

-- ==========================================================================
-- 7. Permisos: REVOKE de PUBLIC y anon explícito (ver la lección de
--    20260822260000 -- CREATE OR REPLACE no resetea grants existentes,
--    pero estos 6 nunca tuvieron un REVOKE explícito hecho en esta sesión,
--    así que se cubre por si acaso, igual que el resto de Fase 2), GRANT a
--    authenticated.
-- ==========================================================================
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.create_employee(bigint, text, text, numeric, numeric, boolean)',
    'public.register_attendance(bigint, bigint)',
    'public.set_payroll_bonus(bigint, bigint, date, boolean)',
    'public.get_payroll_week_credit(bigint, date)',
    'public.get_sale_employee_breakdown(bigint)',
    'public.get_employee_daily_consumption(bigint)'
  ]
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $$;

-- ==========================================================================
-- 8. Limpieza de la función temporal de introspección de este archivo.
-- ==========================================================================
DROP FUNCTION IF EXISTS public.tmp_introspect_payroll_attendance();
DROP FUNCTION IF EXISTS public.tmp_introspect_employees_cols();
