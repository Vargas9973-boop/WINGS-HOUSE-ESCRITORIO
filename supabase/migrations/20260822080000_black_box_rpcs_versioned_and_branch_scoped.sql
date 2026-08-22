-- Punto 2 (cerrar RPC "caja negra"), parte 2/2: los 6 RPCs restantes de la
-- lista pedida por el usuario, ahora con su definición REAL (pedida vía
-- pg_get_functiondef, no adivinada). Ninguna de estas 6 tenía una segunda
-- sobrecarga vieja coexistiendo (a diferencia de las 5 de
-- 20260822060000_drop_dangerous_legacy_overloads.sql) -- se confirmó contra
-- el listado completo de funciones SECURITY DEFINER de public que trajo el
-- usuario. Se separan en dos grupos:
--
-- A) Ya estaban bien (branch_id validado correctamente) -- se versionan tal
--    cual, SIN cambio funcional, solo para que dejen de ser caja negra:
--      - cancel_table(p_sale_id bigint, p_branch_id bigint)
--      - comanda_board(p_branch_id integer)
--    comanda_update_kitchen SÍ recibe un cambio real (guard de transición,
--    ver abajo), pero su firma no cambia.
--
-- B) Firma vieja SIN p_branch_id -- requieren DROP + CREATE con el parámetro
--    nuevo (agregar un parámetro sin DEFAULT cambia la lista de tipos, así
--    que un simple CREATE OR REPLACE dejaría la vieja firma viva, el mismo
--    error que ya se corrigió en 20260822060000):
--      - create_employee: +p_branch_id, branch_id en el INSERT.
--      - get_payroll_week_credit: +p_branch_id, filtro en el WHERE (la tabla
--        que lee, employee_weekly_credit, ya tiene branch_id desde
--        20260822040000_employee_tables_branch_isolation.sql).
--      - register_attendance: +p_branch_id. Además: NO tenía
--        SECURITY DEFINER/search_path (bug real, corregido aquí), validaba
--        el empleado sin filtrar por sucursal, y comparaba
--        "timestamp"::date = CURRENT_DATE -- eso corre en la zona horaria de
--        la sesión de Postgres (UTC en Supabase), no America/Mexico_City,
--        así que una checada después de ~6-7pm hora local ya contaba como
--        "otro día" para el cálculo de entrada/salida (mismo bug de fondo que
--        el de localDateStr en db.js, documentado en el comentario de
--        getTodayAttendance).
--      - set_payroll_bonus: +p_branch_id. Además: el SELECT de empleado NO
--        filtraba por sucursal -- cualquier branch_id podía acreditar/negar
--        el bono semanal de un empleado de OTRA sucursal con solo conocer su
--        id (hueco de ESCRITURA, no solo de lectura). branch_id se agrega
--        también al INSERT en payroll_weeks (la columna ya existe desde
--        20260822040000, pero esta era la única función que la escribe y
--        seguía sin poblarla).

-- ==========================================================================
-- A) Versionado sin cambio funcional
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.cancel_table(p_sale_id bigint, p_branch_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_branch_id IS NULL THEN RAISE EXCEPTION 'p_branch_id requerido'; END IF;
  UPDATE public.sales SET status='cancelada', kitchen_status='cancelada'
  WHERE id=p_sale_id AND branch_id=p_branch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Venta % no existe en branch %', p_sale_id, p_branch_id; END IF;
END; $function$;

GRANT EXECUTE ON FUNCTION public.cancel_table(bigint, bigint) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.comanda_board(p_branch_id integer)
 RETURNS TABLE(id bigint, table_number integer, kitchen_status text, opened_by text, total numeric, created_at timestamp with time zone, items jsonb)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    s.id,
    s.table_number,
    s.kitchen_status,
    s.opened_by,
    s.total,
    s.created_at,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', si.id,
            'name', si.name,
            'quantity', si.quantity,
            'notes', si.notes,
            'modifiers', (
              select coalesce(jsonb_agg(m.name order by m.name), '[]'::jsonb)
              from public.sale_item_modifiers sim
              join public.modifiers m on m.id = sim.modifier_id
              where sim.sale_item_id = si.id
            )
          )
          order by si.id
        )
        from public.sale_items si
        where si.sale_id = s.id
      ),
      '[]'::jsonb
    ) as items
  from public.sales s
  where s.branch_id = p_branch_id
    and s.client_type = 'Mesa'
    and s.status = 'abierta'
  order by s.created_at asc;
$function$;

GRANT EXECUTE ON FUNCTION public.comanda_board(integer) TO anon, authenticated;

-- comanda_update_kitchen: mismo cambio de fondo que
-- 20260821030000_kds_status_transition_guard.sql le hizo a update_kds_status,
-- pero sobre kitchen_status (columna aparte, usada por el tablero web, no la
-- misma que kds_status del KDS de escritorio). Antes: cualquier
-- p_kitchen_status pasaba sin validar y sin comparar contra el estado
-- actual -- Tablero.jsx solo pide el siguiente paso lógico (col.next), así
-- que un salto ilegal nunca sale de esa UI, pero la función está GRANT a
-- anon y es llamable directo con la anon key. Mismo estado = no-op, un paso
-- adelante = ok, cualquier otro salto o retroceso = excepción.
CREATE OR REPLACE FUNCTION public.comanda_update_kitchen(p_id bigint, p_branch_id bigint, p_kitchen_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current_status text;
  v_next_by_current CONSTANT jsonb := '{
    "pendiente": "en_cocina",
    "en_cocina": "listo",
    "listo": "entregado"
  }'::jsonb;
BEGIN
  IF p_branch_id IS NULL THEN RAISE EXCEPTION 'p_branch_id requerido'; END IF;

  IF p_kitchen_status NOT IN ('pendiente', 'en_cocina', 'listo', 'entregado') THEN
    RAISE EXCEPTION 'Estado de cocina inválido: %', p_kitchen_status;
  END IF;

  SELECT COALESCE(kitchen_status, 'pendiente') INTO v_current_status
  FROM public.sales
  WHERE id = p_id AND branch_id = p_branch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venta % no existe en branch %', p_id, p_branch_id;
  END IF;

  IF p_kitchen_status = v_current_status THEN
    RETURN; -- no-op idempotente (doble clic / carrera de refresco)
  END IF;

  IF v_next_by_current->>v_current_status IS DISTINCT FROM p_kitchen_status THEN
    RAISE EXCEPTION
      'Transición de cocina inválida: % -> % (la orden % está en %)',
      v_current_status, p_kitchen_status, p_id, v_current_status;
  END IF;

  UPDATE public.sales SET kitchen_status=p_kitchen_status
  WHERE id=p_id AND branch_id=p_branch_id;
END; $function$;

GRANT EXECUTE ON FUNCTION public.comanda_update_kitchen(bigint, bigint, text) TO anon, authenticated;

-- ==========================================================================
-- B) Firma vieja sin p_branch_id -- DROP de la firma vieja + CREATE nueva
-- ==========================================================================

DROP FUNCTION IF EXISTS public.create_employee(text, text, numeric, numeric, boolean);

CREATE OR REPLACE FUNCTION public.create_employee(
  p_branch_id bigint,
  p_name text,
  p_role text,
  p_salary numeric,
  p_weekly_bonus numeric,
  p_active boolean
)
 RETURNS employees
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_employee public.employees;
BEGIN
    IF p_branch_id IS NULL THEN
        RAISE EXCEPTION 'p_branch_id requerido';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch_id) THEN
        RAISE EXCEPTION 'La sucursal % no existe.', p_branch_id;
    END IF;

    INSERT INTO public.employees (
        branch_id,
        name,
        role,
        salary,
        weekly_bonus,
        active
    )
    VALUES (
        p_branch_id,
        p_name,
        COALESCE(NULLIF(p_role, ''), 'Personal'),
        COALESCE(p_salary, 0),
        COALESCE(p_weekly_bonus, 0),
        COALESCE(p_active, true)
    )
    RETURNING *
    INTO v_employee;

    RETURN v_employee;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.create_employee(bigint, text, text, numeric, numeric, boolean) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.get_payroll_week_credit(date);

CREATE OR REPLACE FUNCTION public.get_payroll_week_credit(p_branch_id bigint, p_week_start date)
 RETURNS TABLE(employee_id bigint, credit_amount numeric, paid_amount numeric)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT employee_id,
           COALESCE(SUM(credit_amount), 0) AS credit_amount,
           COALESCE(SUM(paid_amount), 0) AS paid_amount
    FROM public.employee_weekly_credit
    WHERE week_start = p_week_start
      AND branch_id = p_branch_id
    GROUP BY employee_id;
$function$;

GRANT EXECUTE ON FUNCTION public.get_payroll_week_credit(bigint, date) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.register_attendance(bigint);

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
  IF p_branch_id IS NULL THEN
    RAISE EXCEPTION 'p_branch_id requerido';
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

GRANT EXECUTE ON FUNCTION public.register_attendance(bigint, bigint) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.set_payroll_bonus(bigint, date, boolean);

CREATE OR REPLACE FUNCTION public.set_payroll_bonus(
  p_branch_id bigint,
  p_employee_id bigint,
  p_week_start date,
  p_bonus_credited boolean
)
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

    IF p_branch_id IS NULL THEN
        RAISE EXCEPTION 'p_branch_id requerido';
    END IF;

    -- ============================================================
    -- OBTENER EMPLEADO (ahora acotado a la sucursal -- antes cualquier
    -- branch_id podía acreditar/negar el bono de un empleado ajeno)
    -- ============================================================

    SELECT *
    INTO v_emp
    FROM public.employees
    WHERE id = p_employee_id
      AND branch_id = p_branch_id
      AND active = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Empleado no encontrado, inactivo, o no pertenece a esta sucursal.';
    END IF;


    -- ============================================================
    -- CALCULAR BONO
    -- ============================================================

    v_bonus :=
        CASE
            WHEN p_bonus_credited = true
            THEN COALESCE(v_emp.weekly_bonus, 0)
            ELSE 0
        END;


    -- ============================================================
    -- CALCULAR TOTAL DE NÓMINA
    -- ============================================================

    v_total :=
        COALESCE(v_emp.salary, 0)
        +
        v_bonus;


    -- ============================================================
    -- GUARDAR / ACTUALIZAR SEMANA
    -- ============================================================

    INSERT INTO public.payroll_weeks (
        branch_id,
        employee_id,
        employee_name,
        week_start,
        salary,
        bonus_credited,
        bonus_amount,
        total
    )
    VALUES (
        p_branch_id,
        p_employee_id,
        v_emp.name,
        p_week_start,
        COALESCE(v_emp.salary, 0),
        p_bonus_credited,
        v_bonus,
        v_total
    )

    ON CONFLICT (employee_id, week_start)
    DO UPDATE SET

        branch_id =
            EXCLUDED.branch_id,

        employee_name =
            EXCLUDED.employee_name,

        salary =
            EXCLUDED.salary,

        bonus_credited =
            EXCLUDED.bonus_credited,

        bonus_amount =
            EXCLUDED.bonus_amount,

        total =
            EXCLUDED.total,

        updated_at =
            now();

END;

$function$;

GRANT EXECUTE ON FUNCTION public.set_payroll_bonus(bigint, bigint, date, boolean) TO anon, authenticated;
