-- Opción A -- Tarea 2 / Migración 0009 (parte 1, continuación): costs,
-- cash_cuts, cash_movements. Traducción mecánica de db.js -- sin cambios de
-- comportamiento. close_cash_cut SOLO envuelve el paso de escritura final:
-- el cálculo de "esperado"/getCorteResumen sigue siendo una lectura en JS
-- (las tablas quedan con SELECT abierto en esta fase, ver
-- 20260820010000), así que no hay que duplicar esa agregación en SQL.

CREATE OR REPLACE FUNCTION public.create_cost(
  p_branch_id bigint,
  p_concept text,
  p_category text,
  p_amount numeric,
  p_date date,
  p_metodo_pago text DEFAULT NULL
) RETURNS public.costs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.costs;
BEGIN
  INSERT INTO public.costs (concept, category, amount, date, branch_id, metodo_pago)
  VALUES (p_concept, COALESCE(p_category, 'variable'), COALESCE(p_amount, 0), COALESCE(p_date, (now() AT TIME ZONE 'America/Mexico_City')::date), p_branch_id, p_metodo_pago)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_cost(p_branch_id bigint, p_id bigint)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.costs WHERE id = p_id AND branch_id = p_branch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró el gasto % en esta sucursal', p_id;
  END IF;
  RETURN json_build_object('deleted', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_cash_cut_fondo_inicial(p_branch_id bigint, p_fecha date, p_fondo_inicial numeric)
RETURNS public.cash_cuts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.cash_cuts;
BEGIN
  INSERT INTO public.cash_cuts (fecha, branch_id, fondo_inicial)
  VALUES (p_fecha, p_branch_id, COALESCE(p_fondo_inicial, 0))
  ON CONFLICT (fecha, branch_id) DO UPDATE SET fondo_inicial = EXCLUDED.fondo_inicial
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.close_cash_cut(p_branch_id bigint, p_fecha date, p_fondo_inicial numeric, p_efectivo_real numeric, p_cerrado_por text)
RETURNS public.cash_cuts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_id bigint;
  v_row public.cash_cuts;
BEGIN
  SELECT id INTO v_existing_id FROM public.cash_cuts WHERE fecha = p_fecha AND branch_id = p_branch_id;

  IF v_existing_id IS NOT NULL THEN
    UPDATE public.cash_cuts
    SET fondo_inicial = p_fondo_inicial, efectivo_real = p_efectivo_real,
        cerrado_por = COALESCE(p_cerrado_por, 'admin'), cerrado_at = now()
    WHERE id = v_existing_id
    RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.cash_cuts (fecha, branch_id, fondo_inicial, efectivo_real, cerrado_por, cerrado_at)
    VALUES (p_fecha, p_branch_id, p_fondo_inicial, p_efectivo_real, COALESCE(p_cerrado_por, 'admin'), now())
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_cash_movement(
  p_branch_id bigint,
  p_fecha date,
  p_concepto text,
  p_monto numeric,
  p_metodo_pago text,
  p_categoria_costo text
) RETURNS public.cash_movements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.cash_movements;
  v_cost_category text;
BEGIN
  IF p_concepto IS NULL OR btrim(p_concepto) = '' THEN
    RAISE EXCEPTION 'El concepto de la salida es obligatorio.';
  END IF;

  INSERT INTO public.cash_movements (fecha, concepto, monto, metodo_pago, categoria_costo, branch_id)
  VALUES (COALESCE(p_fecha, (now() AT TIME ZONE 'America/Mexico_City')::date), btrim(p_concepto), COALESCE(p_monto, 0),
          COALESCE(p_metodo_pago, 'efectivo'), COALESCE(p_categoria_costo, 'otros'), p_branch_id)
  RETURNING * INTO v_row;

  v_cost_category := CASE p_categoria_costo
    WHEN 'repartidores' THEN 'variable'
    WHEN 'basura' THEN 'variable'
    WHEN 'insumos' THEN 'insumo'
    WHEN 'otros' THEN 'variable'
    ELSE 'variable'
  END;

  -- Igual que db.js: si el espejo en costs falla, la salida de caja ya
  -- registrada NO se revierte.
  BEGIN
    INSERT INTO public.costs (concept, category, amount, date, metodo_pago, branch_id)
    VALUES (v_row.concepto, v_cost_category, v_row.monto, v_row.fecha, v_row.metodo_pago, p_branch_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'No se pudo espejar la salida en costs: %', SQLERRM;
  END;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_cash_movement(p_branch_id bigint, p_id bigint)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.cash_movements WHERE id = p_id AND branch_id = p_branch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró la salida de caja % en esta sucursal', p_id;
  END IF;
  RETURN json_build_object('deleted', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_cost(bigint, text, text, numeric, date, text) TO anon;
GRANT EXECUTE ON FUNCTION public.remove_cost(bigint, bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.set_cash_cut_fondo_inicial(bigint, date, numeric) TO anon;
GRANT EXECUTE ON FUNCTION public.close_cash_cut(bigint, date, numeric, numeric, text) TO anon;
GRANT EXECUTE ON FUNCTION public.create_cash_movement(bigint, date, text, numeric, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.remove_cash_movement(bigint, bigint) TO anon;
