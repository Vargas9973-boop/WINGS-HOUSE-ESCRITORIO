-- Fix inmediato sobre la propia Fase 2A/2B: las 9 funciones recreadas
-- desde cero en 20260822240000 (update_employee, remove_employee,
-- save_fingerprint, clear_fingerprint, update_sale_payment_status,
-- set_cash_cut_fondo_inicial, close_cash_cut, create_cash_movement,
-- remove_cash_movement) seguían siendo ejecutables por anon -- no porque
-- se les haya hecho GRANT a anon (nunca se hizo), sino porque Postgres
-- otorga EXECUTE a PUBLIC por defecto en toda función nueva, y anon hereda
-- de PUBLIC salvo que se revoque explícito. Las funciones que ya existían
-- antes de esta sesión no tenían este problema porque su GRANT a anon
-- original ya había sido revocado explícitamente arriba -- pero un REVOKE
-- ... FROM anon no toca el privilegio que sigue viniendo de PUBLIC.
-- Confirmado con tmp_verify_fase2ab() después de aplicar 20260822240000.
-- Se revoca de PUBLIC *y* de anon explícitamente -- no está confirmado
-- cuál de los dos es el mecanismo real (podría ser un
-- ALTER DEFAULT PRIVILEGES ... TO anon de alguna migración temprana, no
-- necesariamente PUBLIC), así que se cubren ambos para no depender de
-- adivinar cuál aplica.
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.update_employee(bigint, bigint, text, text, numeric, numeric, boolean)',
    'public.remove_employee(bigint, bigint)',
    'public.save_fingerprint(bigint, bigint, text)',
    'public.clear_fingerprint(bigint, bigint)',
    'public.update_sale_payment_status(bigint, bigint, text)',
    'public.set_cash_cut_fondo_inicial(bigint, date, numeric)',
    'public.close_cash_cut(bigint, date, numeric, numeric, text)',
    'public.create_cash_movement(bigint, date, text, numeric, text, text)',
    'public.remove_cash_movement(bigint, bigint)'
  ]
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', f);
  END LOOP;
END $$;

-- ==========================================================================
-- Segundo fix, mismo archivo: los guards de lectura de 20260822240000 usan
-- `p_branch_id = ANY(current_visible_branch_ids())`. Si esa función
-- devuelve NULL (llamador sin sesión real -- auth.uid() nulo, cero filas
-- en el SELECT interno), toda la expresión sale NULL, y en plpgsql
-- `IF NULL THEN ...` NO ejecuta el RAISE (solo TRUE lo hace) -- el guard
-- se salta en vez de bloquear. Hoy no es explotable porque anon ya no
-- puede ni llamar estas funciones (REVOKE de 20260822240000), pero es una
-- segunda capa de defensa rota que debe corregirse igual -- se envuelve en
-- COALESCE(..., ARRAY[]::bigint[]) para que un llamador sin sesión
-- compare siempre contra un arreglo vacío (NOT false = true, sí dispara).
-- get_user_permissions no tiene este problema (su guard usa EXISTS, que
-- siempre es boolean, nunca NULL).
CREATE OR REPLACE FUNCTION public.get_sale_items_summary(p_branch_id bigint, p_from timestamptz, p_to timestamptz)
 RETURNS TABLE(ref_id integer, item_type character varying, name character varying, quantity integer, subtotal numeric)
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
  SELECT si.ref_id, si.item_type, si.name, si.quantity, si.subtotal
  FROM public.sale_items si
  JOIN public.sales s ON s.id = si.sale_id
  WHERE s.branch_id = p_branch_id
    AND s.status = 'completada'
    AND s.created_at >= p_from
    AND s.created_at <= p_to;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_sale_items_with_modifiers(p_branch_id bigint, p_sale_ids bigint[])
 RETURNS SETOF json
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
  SELECT to_jsonb(si) || jsonb_build_object(
    'sale_item_modifiers',
    COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('id', sim.id, 'modifier_id', sim.modifier_id) ORDER BY sim.id)
         FROM public.sale_item_modifiers sim
        WHERE sim.sale_item_id = si.id),
      '[]'::jsonb
    )
  )
  FROM public.sale_items si
  WHERE si.sale_id = ANY(p_sale_ids)
    AND si.branch_id = p_branch_id
  ORDER BY si.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_all_recipe_costs(p_branch_id bigint)
 RETURNS TABLE(product_id bigint, cost numeric)
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
  SELECT r.product_id, SUM(r.quantity_needed * COALESCE(i.cost_per_unit, 0))
  FROM public.recipes r
  JOIN public.inventory i ON i.id = r.insumo_id
  WHERE r.branch_id = p_branch_id
  GROUP BY r.product_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_recipe_cost(p_branch_id bigint, p_product_id bigint)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cost numeric;
BEGIN
  IF NOT (p_branch_id = ANY (COALESCE(public.current_visible_branch_ids(), ARRAY[]::bigint[]))) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  SELECT SUM(r.quantity_needed * COALESCE(i.cost_per_unit, 0))
    INTO v_cost
    FROM public.recipes r
    JOIN public.inventory i ON i.id = r.insumo_id
   WHERE r.branch_id = p_branch_id AND r.product_id = p_product_id;

  RETURN v_cost;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_roles_by_branch(p_branch_id bigint)
 RETURNS SETOF roles
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
  SELECT * FROM public.roles WHERE branch_id = p_branch_id ORDER BY is_system DESC, name;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_role_permissions(p_branch_id bigint, p_role_id bigint)
 RETURNS SETOF role_permissions
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
  SELECT rp.* FROM public.role_permissions rp
  JOIN public.roles r ON r.id = rp.role_id
  WHERE r.id = p_role_id AND r.branch_id = p_branch_id;
END;
$function$;

-- Mismo fix para get_branch_kds_secret (del hotfix de ayer,
-- 20260822190000) -- idéntico patrón, idéntico bug.
CREATE OR REPLACE FUNCTION public.get_branch_kds_secret(p_branch_id bigint)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_secret text;
BEGIN
  IF NOT (p_branch_id = ANY (COALESCE(public.current_visible_branch_ids(), ARRAY[]::bigint[]))) THEN
    RAISE EXCEPTION 'No tienes acceso a esa sucursal.';
  END IF;

  SELECT secret INTO v_secret FROM public.branch_kds_secrets WHERE branch_id = p_branch_id;
  RETURN v_secret;
END;
$$;
