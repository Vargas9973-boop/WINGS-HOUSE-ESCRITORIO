-- Opción A -- Tarea 2 / Migración 0009 (parte 1, continuación): employees,
-- drivers, waste -- las 3 tablas a las que 20260820000000 les acaba de
-- agregar branch_id. Traducción mecánica de db.js -- sin cambios de
-- comportamiento, salvo que el lookup de inventory_id dentro de
-- create_waste_entry ahora SÍ valida sucursal (antes no lo hacía, era el
-- hallazgo ALTO de la auditoría en createWaste).

CREATE OR REPLACE FUNCTION public.update_employee(
  p_branch_id bigint, p_id bigint, p_name text, p_role text,
  p_salary numeric, p_weekly_bonus numeric, p_active boolean
) RETURNS public.employees
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.employees;
BEGIN
  UPDATE public.employees
  SET name = p_name, role = COALESCE(p_role, 'Personal'),
      salary = COALESCE(p_salary, 0), weekly_bonus = COALESCE(p_weekly_bonus, 0),
      active = COALESCE(p_active, true)
  WHERE id = p_id AND branch_id = p_branch_id
  RETURNING * INTO v_row;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'No se encontró el empleado % en esta sucursal', p_id;
  END IF;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_employee(p_branch_id bigint, p_id bigint)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_in_use bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.employees WHERE id = p_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró el empleado % en esta sucursal', p_id;
  END IF;

  SELECT count(*) INTO v_in_use FROM public.attendance WHERE employee_id = p_id;

  IF v_in_use > 0 THEN
    UPDATE public.employees SET active = false WHERE id = p_id AND branch_id = p_branch_id;
    RETURN json_build_object('deleted', false, 'deactivated', true);
  END IF;

  DELETE FROM public.employees WHERE id = p_id AND branch_id = p_branch_id;
  RETURN json_build_object('deleted', true, 'deactivated', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.save_fingerprint(p_branch_id bigint, p_employee_id bigint, p_template text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.employees
  SET fingerprint_template = p_template, fingerprint_enrolled = true
  WHERE id = p_employee_id AND branch_id = p_branch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró el empleado % en esta sucursal', p_employee_id;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_fingerprint(p_branch_id bigint, p_employee_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.employees
  SET fingerprint_template = NULL, fingerprint_enrolled = false
  WHERE id = p_employee_id AND branch_id = p_branch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró el empleado % en esta sucursal', p_employee_id;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_driver(p_branch_id bigint, p_name text, p_phone text)
RETURNS public.drivers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.drivers;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'El nombre del repartidor es obligatorio.';
  END IF;

  INSERT INTO public.drivers (name, phone, branch_id)
  VALUES (btrim(p_name), p_phone, p_branch_id)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_waste_entry(
  p_branch_id bigint,
  p_inventory_id bigint,
  p_item_name text,
  p_quantity numeric,
  p_unit text,
  p_reason text,
  p_cost numeric,
  p_tipo text,
  p_autorizado_por text
) RETURNS public.waste
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv public.inventory;
  v_item_name text := p_item_name;
  v_unit text := COALESCE(p_unit, 'pza');
  v_cost numeric := COALESCE(p_cost, 0);
  v_tipo text := CASE WHEN p_tipo = 'consumo_interno' THEN 'consumo_interno' ELSE 'merma' END;
  v_autorizado_por text;
  v_reason text;
  v_row public.waste;
BEGIN
  v_autorizado_por := CASE WHEN v_tipo = 'consumo_interno' THEN btrim(COALESCE(p_autorizado_por, '')) ELSE NULL END;
  IF v_tipo = 'consumo_interno' AND (v_autorizado_por IS NULL OR v_autorizado_por = '') THEN
    RAISE EXCEPTION 'Indica qué jefe autoriza el consumo interno.';
  END IF;

  v_reason := CASE
    WHEN v_tipo = 'consumo_interno' THEN 'CONSUMO JEFE - ' || v_autorizado_por || ' - ' || COALESCE(p_reason, 'Sin especificar')
    ELSE COALESCE(p_reason, 'Sin especificar')
  END;

  IF p_inventory_id IS NOT NULL THEN
    SELECT * INTO v_inv FROM public.inventory WHERE id = p_inventory_id AND branch_id = p_branch_id;
    IF v_inv IS NOT NULL THEN
      v_item_name := v_inv.name;
      v_unit := v_inv.unit;
      IF p_cost IS NULL THEN
        v_cost := v_inv.cost_per_unit * COALESCE(p_quantity, 0);
      END IF;
      UPDATE public.inventory
      SET stock = GREATEST(0, stock - COALESCE(p_quantity, 0)), updated_at = now()
      WHERE id = p_inventory_id AND branch_id = p_branch_id;
    END IF;
  END IF;

  INSERT INTO public.waste (inventory_id, item_name, quantity, unit, reason, cost, tipo, autorizado_por, branch_id)
  VALUES (p_inventory_id, v_item_name, COALESCE(p_quantity, 0), v_unit, v_reason, v_cost, v_tipo, v_autorizado_por, p_branch_id)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_employee(bigint, bigint, text, text, numeric, numeric, boolean) TO anon;
GRANT EXECUTE ON FUNCTION public.remove_employee(bigint, bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.save_fingerprint(bigint, bigint, text) TO anon;
GRANT EXECUTE ON FUNCTION public.clear_fingerprint(bigint, bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.create_driver(bigint, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.create_waste_entry(bigint, bigint, text, numeric, text, text, numeric, text, text) TO anon;
