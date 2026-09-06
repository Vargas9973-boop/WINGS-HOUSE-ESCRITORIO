-- QA de aislamiento entre tenants (2026-09-05, con Tenant 1 ya operando con
-- ventas reales): auditoría estática de las ~89 funciones SECURITY DEFINER
-- que reciben p_branch_id/p_tenant_id, comparando contra el patrón ya
-- establecido en el resto del código (validar p_branch_id contra
-- current_branch_id()/current_visible_branch_ids(), o is_superadmin() para
-- las de panel admin). 3 funciones NO seguían ese patrón:
--
-- 1. get_sale_payments(p_branch_id, p_sale_ids) -- CRÍTICO. Sin ningún check
--    de sucursal: cualquier usuario autenticado (empleado de CUALQUIER
--    tenant) podía leer método de pago + monto de las ventas "mixto" de
--    OTRO tenant con solo mandar su branch_id y un rango de sale_id (los
--    ids son correlativos globales, fáciles de barrer). Fuga real de datos
--    financieros de Tenant 1. Fix: exige p_branch_id = current_branch_id().
--
-- 2. get_promotion_modifier_groups_by_branch(p_branch_id) -- ALTO. Ni check
--    de sucursal NI de sesión -- GRANT a `anon`, así que cualquiera en
--    internet, sin loguearse, podía leer la config de grupos de
--    modificadores de promociones de cualquier tenant. Fix: reescrita con
--    el mismo patrón que su hermana de productos
--    (get_product_modifier_groups_by_branch, current_visible_branch_ids()),
--    y se revoca el GRANT a anon.
--
-- 3. set_promotion_modifier_group(p_branch_id, p_promotion_id, ...) --
--    CRÍTICO. Mismo hueco que la anterior pero de ESCRITURA: solo validaba
--    que p_promotion_id perteneciera a p_branch_id (autoconsistencia), sin
--    verificar que el LLAMADOR tuviera permiso sobre esa sucursal. GRANT a
--    `anon` -- cualquiera sin sesión podía crear/borrar grupos de
--    modificadores en las promociones de cualquier tenant. Fix: agrega el
--    mismo guard que su hermana set_product_modifier_group
--    (p_branch_id = current_branch_id()), y se revoca el GRANT a anon.
--
-- Ambas funciones de promociones se crearon en 20260901000000 sin el guard
-- que sí tiene su propia hermana de productos en el mismo archivo de
-- referencia (20260822310000_fase2c_medio_authz.sql) -- se copió la mitad
-- del patrón (autoconsistencia branch/promotion) pero no la validación de
-- sesión, y además se otorgó a anon en vez de a authenticated.
--
-- Un 4to caso (wh_next_folio) se encontró sin guard pero es solo un
-- contador de folio (INSERT ... ON CONFLICT DO UPDATE last_seq = last_seq+1)
-- -- no expone ni modifica datos de negocio, el peor caso es "saltarle" el
-- folio del día a otra sucursal si alguien ya autenticado adivina su
-- branch_id. Se corrige aquí también por consistencia con el resto del
-- código, no por ser una fuga de información.
--
-- No se tocan aquí: seed_default_user (ya inerte -- ver comentario en
-- 20260822180000, hace no-op en cuanto CUALQUIER fila exista en `users`, y
-- Tenant 1 ya tiene usuarios reales) ni create_modifier (el guard existente
-- usa `IS DISTINCT FROM`, que sí dejaría pasar p_branch_id=NULL desde anon
-- -- pero el resultado es una fila huérfana branch_id=NULL, invisible para
-- cualquier lectura real filtrada por sucursal, no una fuga cruzada; queda
-- como mejora menor de higiene, no como hallazgo de esta pasada).

CREATE OR REPLACE FUNCTION public.get_sale_payments(p_branch_id bigint, p_sale_ids bigint[])
RETURNS TABLE(sale_id bigint, payment_method text, amount numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  RETURN QUERY
  SELECT sp.sale_id, sp.payment_method, sp.amount
  FROM public.sale_payments sp
  WHERE sp.branch_id = p_branch_id
    AND sp.sale_id = ANY(p_sale_ids);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_promotion_modifier_groups_by_branch(p_branch_id bigint)
RETURNS SETOF public.promotion_modifier_groups
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
  SELECT pmg.* FROM public.promotion_modifier_groups pmg
  JOIN public.promotions pr ON pr.id = pmg.promotion_id
  WHERE pr.branch_id = p_branch_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_promotion_modifier_group(p_branch_id bigint, p_promotion_id bigint, p_group_name text, p_enabled boolean, p_qty integer DEFAULT 1)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.promotions WHERE id = p_promotion_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró la promoción % en esta sucursal', p_promotion_id;
  END IF;

  DELETE FROM public.promotion_modifier_groups WHERE promotion_id = p_promotion_id AND group_name = p_group_name;

  IF p_enabled THEN
    INSERT INTO public.promotion_modifier_groups (promotion_id, group_name, qty)
    VALUES (p_promotion_id, p_group_name, GREATEST(1, COALESCE(p_qty, 1)));
  END IF;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.wh_next_folio(p_branch_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_day text := to_char(now() AT TIME ZONE 'America/Mexico_City', 'YYYYMMDD');
  v_seq int;
BEGIN
  IF p_branch_id IS NULL THEN
    RAISE EXCEPTION 'p_branch_id requerido';
  END IF;
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  INSERT INTO public.folio_counters (day, last_seq, branch_id)
  VALUES (v_day, 1, p_branch_id)
  ON CONFLICT (day, branch_id) DO UPDATE SET last_seq = public.folio_counters.last_seq + 1
  RETURNING last_seq INTO v_seq;

  RETURN v_day || '-' || lpad(v_seq::text, 4, '0');
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_promotion_modifier_groups_by_branch(bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_promotion_modifier_group(bigint, bigint, text, boolean, integer) FROM anon;
