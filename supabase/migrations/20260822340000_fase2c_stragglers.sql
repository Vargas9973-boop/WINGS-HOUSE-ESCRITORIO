-- Cierre final de Fase 2C: la verificación posterior a 20260822310000
-- encontró más funciones anon-callable de las que la clasificación
-- original contaba (mi primer barrido, por grep sobre archivos de
-- migración, no había capturado estas). Triage:
--
--   - cancel_table, comanda_board, comanda_set_delivery,
--     comanda_update_kitchen: llamadores reales confirmados en db.js /
--     wing-house-web (grep de `.rpc(...)`). Se les agrega el guard
--     completo, mismo patrón que el resto de Fase 2C.
--   - create_employee, register_attendance, set_payroll_bonus,
--     get_payroll_week_credit: llamadores reales, pero NO mandan
--     p_branch_id en absoluto -- db.js lo documenta como deuda pendiente
--     ("RPC caja negra") desde ANTES de esta sesión. Arreglar esto de
--     verdad requiere decidir de dónde sale branch_id ahí (¿derivarlo de
--     employee_id via JOIN a employees?) y probablemente ya está roto en
--     producción (mismatch de firma) -- fuera de alcance de "cerrar
--     anon", así que solo se les revoca anon aquí (quedan authenticated-only,
--     sin tocar su lógica) y se deja documentado como pendiente real para
--     la próxima sesión.
--   - set_setting, get_employee_daily_consumption, get_sale_employee_breakdown,
--     get_sale_for_print, decrement_inventory, clone_catalog_to_branch,
--     comanda_get_sale, comanda_get_tables, wh_next_folio (2 overloads),
--     generate_folio, current_branch_id, current_visible_branch_ids: sin
--     llamador confirmado en ningún .js/.jsx del repo (grep exhaustivo) --
--     código muerto o utilidades internas. Se revoca anon por higiene, sin
--     tocar lógica (no hay nada que romper si nadie las llama).

-- ==========================================================================
-- 1. Guard completo (llamadores reales, firma sin cambios)
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.cancel_table(p_sale_id bigint, p_branch_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;
  UPDATE public.sales SET status='cancelada', kitchen_status='cancelada'
  WHERE id=p_sale_id AND branch_id=p_branch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Venta % no existe en branch %', p_sale_id, p_branch_id; END IF;
END; $function$;

CREATE OR REPLACE FUNCTION public.comanda_board(p_branch_id integer)
 RETURNS TABLE(id bigint, table_number integer, kitchen_status text, opened_by text, total numeric, created_at timestamp with time zone, items jsonb)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (p_branch_id::bigint = ANY (COALESCE(public.current_visible_branch_ids(), ARRAY[]::bigint[]))) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  RETURN QUERY
  select
    s.id, s.table_number, s.kitchen_status, s.opened_by, s.total, s.created_at,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', si.id, 'name', si.name, 'quantity', si.quantity, 'notes', si.notes,
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
END;
$function$;

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
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

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
    RETURN;
  END IF;

  IF v_next_by_current->>v_current_status IS DISTINCT FROM p_kitchen_status THEN
    RAISE EXCEPTION
      'Transición de cocina inválida: % -> % (la orden % está en %)',
      v_current_status, p_kitchen_status, p_id, v_current_status;
  END IF;

  UPDATE public.sales SET kitchen_status=p_kitchen_status
  WHERE id=p_id AND branch_id=p_branch_id;
END; $function$;

-- comanda_set_delivery no recibe p_branch_id -- se deriva de la venta misma
-- (mismo patrón que liquidate_driver_sales en Fase 2A/2B).
CREATE OR REPLACE FUNCTION public.comanda_set_delivery(p_sale_id bigint, p_customer_name text, p_customer_phone text, p_delivery_address text, p_delivery_fee numeric, p_driver_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.sales
  SET is_delivery = true,
      customer_name = p_customer_name,
      customer_phone = p_customer_phone,
      delivery_address = p_delivery_address,
      delivery_fee = COALESCE(p_delivery_fee, 0),
      driver_name = p_driver_name,
      delivery_status = 'pendiente',
      payment_status = 'pendiente',
      total = total + COALESCE(p_delivery_fee, 0)
  WHERE id = p_sale_id
    AND client_type = 'Llevar'
    AND branch_id = public.current_branch_id();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró una venta "Llevar" con id % en esta sucursal', p_sale_id;
  END IF;
END;
$function$;

-- ==========================================================================
-- 2. Solo REVOKE anon (sin tocar lógica) -- llamadores reales pero con
--    deuda de branch_id preexistente a esta sesión, o sin llamador
--    confirmado.
-- ==========================================================================
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.cancel_table(bigint, bigint)',
    'public.comanda_board(integer)',
    'public.comanda_update_kitchen(bigint, bigint, text)',
    'public.comanda_set_delivery(bigint, text, text, text, numeric, text)',
    'public.create_employee(bigint, text, text, numeric, numeric, boolean)',
    'public.register_attendance(bigint, bigint)',
    'public.set_payroll_bonus(bigint, bigint, date, boolean)',
    'public.get_payroll_week_credit(bigint, date)',
    'public.set_setting(text, text)',
    'public.get_employee_daily_consumption(bigint)',
    'public.get_sale_employee_breakdown(bigint)',
    'public.get_sale_for_print(bigint)',
    'public.decrement_inventory(integer, numeric)',
    'public.clone_catalog_to_branch(bigint, bigint)',
    'public.comanda_get_sale(bigint)',
    'public.comanda_get_tables()',
    'public.wh_next_folio()',
    'public.wh_next_folio(bigint)',
    'public.generate_folio()',
    'public.current_branch_id()',
    'public.current_visible_branch_ids()'
  ]
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.tmp_introspect_stragglers();
DROP FUNCTION IF EXISTS public.tmp_final_verify();
