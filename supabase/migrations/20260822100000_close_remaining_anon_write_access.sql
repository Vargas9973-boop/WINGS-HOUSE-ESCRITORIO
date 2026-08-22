-- Hallazgo de seguridad (auditoría 2026-08-22, "dando prioridad a la
-- seguridad"): 20260820010000_deny_anon_direct_access.sql cerró
-- INSERT/UPDATE/DELETE para anon en 14 tablas, pero excluyó a propósito
-- ("Fase 2 pendiente") 7 tablas que TODAVÍA tienen su policy original
-- "allow_anon_all" FOR ALL USING(true) WITH CHECK(true) (o TO anon
-- equivalente): products, modifiers, recipes, settings, payroll_deductions,
-- payroll_history, payroll_weeks. Cualquiera con la anon key (embebida en
-- el instalador de Electron y en el bundle web) puede hoy escribir
-- CUALQUIER fila de estas tablas, de CUALQUIER sucursal, directo por REST
-- -- saltándose todas las validaciones de los RPC (price>0 de
-- create_product/update_product, branch check de set_payroll_bonus, etc.)
-- construidas el resto de esta semana.
--
-- No se puede simplemente cerrar escritura como se hizo con las otras 14:
-- 3 de estas tablas tenían escrituras DIRECTAS desde el cliente (db.js)
-- dependiendo de que la policy estuviera abierta:
--   - settings: db.js::setSetting() hacía upsert directo (rodeando el RPC
--     set_setting, "caja negra" nunca versionado -- ver
--     [[real-branch-isolation]]).
--   - payroll_deductions: db.js::createSale() insertaba la deducción de
--     crédito semanal directo; db.js::closePayrollWeek() marcaba
--     status='descontado' directo.
--   - payroll_history: db.js::closePayrollWeek() hacía el upsert del
--     snapshot directo.
-- Se crean 4 RPC SECURITY DEFINER NUEVOS (nombres nuevos -- no hay
-- sobrecarga vieja que evitar, ver
-- [[postgres-create-or-replace-overload-trap]]) que hacen exactamente lo
-- mismo que esos 3 puntos de escritura, validando p_branch_id, y db.js ya
-- se actualizó para llamarlos en vez de escribir directo. products,
-- modifiers, recipes, payroll_weeks NO tenían ninguna escritura directa
-- (ya iban todas por create_product/update_product/set_recipes_for_product/
-- set_payroll_bonus, confirmado por grep en db.js y wing-house-web) --
-- esas 4 se cierran sin RPC nuevo.

-- ==========================================================================
-- RPCs nuevos que reemplazan las 3 escrituras directas
-- ==========================================================================

CREATE FUNCTION public.set_branch_setting(p_branch_id bigint, p_key text, p_value text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_branch_id IS NULL THEN
    RAISE EXCEPTION 'p_branch_id requerido';
  END IF;

  INSERT INTO public.settings (key, value, branch_id)
  VALUES (p_key, p_value, p_branch_id)
  ON CONFLICT (key, branch_id) DO UPDATE SET value = EXCLUDED.value;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.set_branch_setting(bigint, text, text) TO anon, authenticated;

CREATE FUNCTION public.create_payroll_deduction(
  p_branch_id bigint,
  p_employee_name text,
  p_amount numeric,
  p_sale_id bigint,
  p_reason text,
  p_status text,
  p_week_start date,
  p_week_end date
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_branch_id IS NULL THEN
    RAISE EXCEPTION 'p_branch_id requerido';
  END IF;

  INSERT INTO public.payroll_deductions (
    branch_id, employee_name, amount, sale_id, reason, status, week_start, week_end
  ) VALUES (
    p_branch_id, p_employee_name, p_amount, p_sale_id, p_reason, p_status, p_week_start, p_week_end
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.create_payroll_deduction(bigint, text, numeric, bigint, text, text, date, date) TO anon, authenticated;

-- p_rows: mismo shape que el "snapshot" que closePayrollWeek() ya arma en
-- JS (un objeto por empleado con las columnas de payroll_history, más
-- branch_id) -- se valida branch_id de cada renglón contra p_branch_id en
-- vez de confiar en lo que traiga el jsonb.
CREATE FUNCTION public.upsert_payroll_history(p_branch_id bigint, p_rows jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row jsonb;
BEGIN
  IF p_branch_id IS NULL THEN
    RAISE EXCEPTION 'p_branch_id requerido';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    INSERT INTO public.payroll_history (
      branch_id, week_start, week_end, employee_id, employee_name,
      sueldo_base, creditos, faltas, deduccion_faltas, beneficio_usado,
      total_pagado, cerrado_por
    ) VALUES (
      p_branch_id,
      (v_row->>'week_start')::date,
      (v_row->>'week_end')::date,
      (v_row->>'employee_id')::bigint,
      v_row->>'employee_name',
      COALESCE((v_row->>'sueldo_base')::numeric, 0),
      COALESCE((v_row->>'creditos')::numeric, 0),
      COALESCE((v_row->>'faltas')::int, 0),
      COALESCE((v_row->>'deduccion_faltas')::numeric, 0),
      COALESCE((v_row->>'beneficio_usado')::numeric, 0),
      COALESCE((v_row->>'total_pagado')::numeric, 0),
      v_row->>'cerrado_por'
    )
    ON CONFLICT (week_start, employee_id) DO UPDATE SET
      branch_id = EXCLUDED.branch_id,
      week_end = EXCLUDED.week_end,
      employee_name = EXCLUDED.employee_name,
      sueldo_base = EXCLUDED.sueldo_base,
      creditos = EXCLUDED.creditos,
      faltas = EXCLUDED.faltas,
      deduccion_faltas = EXCLUDED.deduccion_faltas,
      beneficio_usado = EXCLUDED.beneficio_usado,
      total_pagado = EXCLUDED.total_pagado,
      cerrado_por = EXCLUDED.cerrado_por,
      cerrado_at = now();
  END LOOP;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.upsert_payroll_history(bigint, jsonb) TO anon, authenticated;

CREATE FUNCTION public.close_payroll_deductions(p_branch_id bigint, p_from timestamptz, p_to timestamptz)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_branch_id IS NULL THEN
    RAISE EXCEPTION 'p_branch_id requerido';
  END IF;

  UPDATE public.payroll_deductions
     SET status = 'descontado'
   WHERE status = 'pendiente'
     AND branch_id = p_branch_id
     AND created_at >= p_from
     AND created_at <= p_to;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.close_payroll_deductions(bigint, timestamptz, timestamptz) TO anon, authenticated;

-- ==========================================================================
-- Cierre de escritura directa para anon (mismo patrón que
-- 20260820010000_deny_anon_direct_access.sql): SELECT sigue abierto
-- (lecturas ya filtradas por branch_id del lado de la app), INSERT/UPDATE/
-- DELETE quedan negados -- toda escritura debe pasar por un RPC SECURITY
-- DEFINER de aquí en adelante.
-- ==========================================================================

DO $$
DECLARE
  v_table text;
  v_policy record;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'products', 'modifiers', 'recipes', 'settings',
    'payroll_deductions', 'payroll_history', 'payroll_weeks'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);

    FOR v_policy IN
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = v_table
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', v_policy.policyname, v_table);
    END LOOP;

    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO anon USING (true)', v_table || '_select_anon', v_table);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO anon WITH CHECK (false)', v_table || '_insert_deny_anon', v_table);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO anon USING (false)', v_table || '_update_deny_anon', v_table);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO anon USING (false)', v_table || '_delete_deny_anon', v_table);
  END LOOP;
END $$;

-- ============================================================
-- DEUDA PENDIENTE QUE SIGUE ABIERTA (sin cambio en esta migración):
--   - SELECT sigue abierto a anon en estas 7 tablas + las 14 de
--     20260820010000 -- las lecturas siguen filtradas solo del lado de la
--     app, no por RLS real. Mismo "Fase 2" ya documentado ahí.
--   - users (INSERT/UPDATE) sigue sin tocarse -- depende de resolver el
--     login sin exponer password_hash/salt primero.
--   - El problema de fondo (RLS/RPCs confían en el p_branch_id que manda el
--     cliente, no hay sesión verificada server-side) sigue sin resolver,
--     por decisión explícita del usuario -- ver [[real-branch-isolation]].
-- ============================================================
