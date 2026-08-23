-- Fase 2C: las ~40 funciones restantes (catálogo/inventario/comandas,
-- clasificación MEDIO -- escriben/leen datos de otra sucursal si se manda
-- otro branch_id, pero no mueven dinero/nómina/RRHH directo como las de
-- Fase 2A/2B). Mismo patrón que 20260822240000: escrituras validan
-- p_branch_id = current_branch_id(), lecturas validan
-- p_branch_id = ANY(current_visible_branch_ids()), NULL-safe desde el
-- origen (COALESCE(..., ARRAY[]::bigint[])) -- ver el bug de
-- 20260822260000, no se repite aquí.
--
-- Segundo hallazgo no buscado, mismo patrón que ya apareció dos veces en
-- esta sesión (funciones "arregladas" en el papel que en verdad no lo
-- están): comanda_open_table, comanda_add_item, comanda_update_item_qty,
-- comanda_remove_item, comanda_assign_driver y comanda_open_takeout NO
-- reciben p_branch_id en su firma viva hoy -- pero tanto db.js como
-- wing-house-web/comandas.jsx YA las llaman mandando p_branch_id (grep
-- confirmado en ambos). Es decir, esas llamadas están rotas ahora mismo
-- (PostgREST no encuentra una función con ese parámetro extra). Se agrega
-- el parámetro que el cliente ya manda -- cero cambios de JS en ninguna
-- de las dos apps, y de paso deja de estar roto.
--
-- Tercer hallazgo: comanda_open_takeout tenía un segundo overload
-- (p_atiende text, p_productos jsonb) que inserta en una tabla `comandas`
-- vestigial (no es SECURITY DEFINER siquiera) -- cero referencias en todo
-- el repo JS (grep confirmado). Se dropea como limpieza, mismo criterio
-- que el overload huérfano de process_sale.
--
-- Cuarto: comanda_open_table no seteaba branch_id en el INSERT (la
-- columna no tiene DEFAULT desde 20260820900000) -- hubiera tronado por
-- NOT NULL en cuanto alguien la llamara. Y el check de "¿ya hay una mesa
-- abierta con este número?" no filtraba por sucursal -- dos sucursales
-- con "mesa 5" abierta al mismo tiempo se hubieran pisado. Ambos se
-- corrigen de paso.
--
-- 12 de las MEDIO tampoco existen en pg_proc (mismo patrón que las 9
-- CRÍTICAS de Fase 2A/2B, confirmado con tmp_introspect_fase2c_missing):
-- remove_promotion, create_inventory_item, update_inventory_item,
-- remove_inventory_item, add_inventory_stock, create_driver,
-- create_waste_entry, comanda_add_item_with_modifiers,
-- comanda_update_delivery_status, set_sale_cashier,
-- set_sale_item_notes_and_modifiers, mark_sale_printed -- se recrean aquí
-- con el guard incluido desde el origen.
--
-- Recordatorio de la lección de 20260822260000: toda función CREATE-ada
-- (no CREATE OR REPLACE-ada sobre una que ya existía) recibe EXECUTE para
-- anon automáticamente pese a no habérselo otorgado explícito -- se
-- revoca de PUBLIC y de anon explícito para TODAS, sin asumir cuáles
-- "seguro que no lo necesitan".

-- ==========================================================================
-- 1. Comandas: firma nueva (p_branch_id agregado) -- DROP explícito de la
--    vieja primero, no CREATE OR REPLACE (cambia la lista de tipos).
-- ==========================================================================
DROP FUNCTION IF EXISTS public.comanda_open_table(integer, text);

CREATE FUNCTION public.comanda_open_table(p_branch_id bigint, p_table_number integer, p_opened_by text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_id bigint;
BEGIN
    IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
        RAISE EXCEPTION 'branch mismatch';
    END IF;

    IF p_table_number IS NULL OR p_table_number <= 0 THEN
        RAISE EXCEPTION 'Número de mesa inválido.';
    END IF;

    PERFORM pg_advisory_xact_lock(p_table_number::bigint);

    SELECT s.id
      INTO v_id
      FROM public.sales s
     WHERE s.status = 'abierta'
       AND s.table_number = p_table_number
       AND s.branch_id = p_branch_id
     ORDER BY s.id DESC
     LIMIT 1;

    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;

    INSERT INTO public.sales (
        client_type, payment_method, total, status, table_number, opened_by, printed, branch_id
    )
    VALUES (
        'Mesa', 'efectivo', 0, 'abierta', p_table_number, p_opened_by, false, p_branch_id
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$function$;

DROP FUNCTION IF EXISTS public.comanda_open_takeout(text);
DROP FUNCTION IF EXISTS public.comanda_open_takeout(text, jsonb);

CREATE FUNCTION public.comanda_open_takeout(p_branch_id bigint, p_opened_by text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_id bigint;
BEGIN
    IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
        RAISE EXCEPTION 'branch mismatch';
    END IF;

    INSERT INTO public.sales (
        client_type, payment_method, total, status, table_number, opened_by, printed, branch_id
    )
    VALUES (
        'Para llevar', 'efectivo', 0, 'abierta', NULL, p_opened_by, false, p_branch_id
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$function$;

DROP FUNCTION IF EXISTS public.comanda_add_item(bigint, integer, text, text, numeric, integer);

CREATE FUNCTION public.comanda_add_item(p_branch_id bigint, p_sale_id bigint, p_ref_id integer, p_item_type text, p_name text, p_unit_price numeric, p_quantity integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_status character varying;
    v_existing_id bigint;
    v_existing_qty integer;
    v_stock numeric;
    v_new_qty integer;
BEGIN
    IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
        RAISE EXCEPTION 'branch mismatch';
    END IF;

    IF p_sale_id IS NULL OR p_sale_id <= 0 THEN
        RAISE EXCEPTION 'ID de comanda inválido.';
    END IF;

    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        RAISE EXCEPTION 'La cantidad debe ser mayor que cero.';
    END IF;

    IF p_name IS NULL OR btrim(p_name) = '' THEN
        RAISE EXCEPTION 'El nombre del artículo es obligatorio.';
    END IF;

    IF p_unit_price IS NULL OR p_unit_price < 0 THEN
        RAISE EXCEPTION 'El precio del artículo es inválido.';
    END IF;

    SELECT s.status
      INTO v_status
      FROM public.sales s
     WHERE s.id = p_sale_id
       AND s.branch_id = p_branch_id
     FOR UPDATE;

    IF v_status IS NULL THEN
        RAISE EXCEPTION 'La comanda no existe en esta sucursal.';
    END IF;

    IF v_status <> 'abierta' THEN
        RAISE EXCEPTION 'La comanda ya no está abierta.';
    END IF;

    SELECT si.id, si.quantity
      INTO v_existing_id, v_existing_qty
      FROM public.sale_items si
     WHERE si.sale_id = p_sale_id
       AND si.item_type = COALESCE(p_item_type, 'product')
       AND (
            (p_ref_id IS NULL AND si.ref_id IS NULL)
            OR si.ref_id = p_ref_id
       )
     ORDER BY si.id
     LIMIT 1
     FOR UPDATE;

    v_new_qty := COALESCE(v_existing_qty, 0) + p_quantity;

    IF COALESCE(p_item_type, 'product') = 'product'
       AND p_ref_id IS NOT NULL
    THEN
        SELECT p.stock
          INTO v_stock
          FROM public.products p
         WHERE p.id = p_ref_id
           AND p.branch_id = p_branch_id
           AND p.active = true
         FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'El producto no existe o está inactivo.';
        END IF;

        IF v_stock IS NOT NULL AND v_stock < v_new_qty THEN
            RAISE EXCEPTION '"%" no tiene existencia suficiente. Disponible: %, solicitado: %.',
                p_name, v_stock, v_new_qty;
        END IF;
    END IF;

    IF v_existing_id IS NOT NULL THEN
        UPDATE public.sale_items
           SET quantity = v_new_qty,
               subtotal = v_new_qty * unit_price
         WHERE id = v_existing_id;
    ELSE
        INSERT INTO public.sale_items (
            sale_id, ref_id, item_type, name, unit_price, quantity, subtotal
        )
        VALUES (
            p_sale_id, p_ref_id, COALESCE(p_item_type, 'product'), p_name, p_unit_price, p_quantity, p_unit_price * p_quantity
        );
    END IF;

    UPDATE public.sales s
       SET total = x.subtotal
      FROM (
          SELECT sale_id, COALESCE(SUM(subtotal), 0) AS subtotal
            FROM public.sale_items
           WHERE sale_id = p_sale_id
           GROUP BY sale_id
      ) x
     WHERE s.id = x.sale_id;
END;
$function$;

DROP FUNCTION IF EXISTS public.comanda_update_item_qty(bigint, integer);

CREATE FUNCTION public.comanda_update_item_qty(p_branch_id bigint, p_item_id bigint, p_quantity integer)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_sale_id bigint;
    v_sale json;
BEGIN
    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        RAISE EXCEPTION 'La cantidad debe ser mayor que cero.';
    END IF;

    SELECT si.sale_id
    INTO v_sale_id
    FROM public.sale_items si
    JOIN public.sales s ON s.id = si.sale_id
    WHERE si.id = p_item_id AND s.branch_id = p_branch_id
    LIMIT 1;

    IF v_sale_id IS NULL THEN
        RAISE EXCEPTION 'No se encontró el artículo de la comanda en esta sucursal.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.sales WHERE id = v_sale_id AND status = 'abierta'
    ) THEN
        RAISE EXCEPTION 'La mesa ya no está abierta.';
    END IF;

    UPDATE public.sale_items
    SET quantity = p_quantity,
        subtotal = COALESCE(unit_price, 0) * p_quantity
    WHERE id = p_item_id;

    UPDATE public.sales
    SET total = COALESCE(
        (SELECT SUM(si.subtotal) FROM public.sale_items si WHERE si.sale_id = v_sale_id),
        0
    )
    WHERE id = v_sale_id AND status = 'abierta';

    SELECT row_to_json(s) INTO v_sale FROM public.sales s WHERE s.id = v_sale_id LIMIT 1;
    IF v_sale IS NULL THEN
        RAISE EXCEPTION 'No se pudo recuperar la mesa actualizada.';
    END IF;
    RETURN v_sale;
END;
$function$;

DROP FUNCTION IF EXISTS public.comanda_remove_item(bigint);

CREATE FUNCTION public.comanda_remove_item(p_branch_id bigint, p_item_id bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_sale_id bigint;
    v_sale json;
BEGIN
    SELECT si.sale_id
    INTO v_sale_id
    FROM public.sale_items si
    JOIN public.sales s ON s.id = si.sale_id
    WHERE si.id = p_item_id AND s.branch_id = p_branch_id
    LIMIT 1;

    IF v_sale_id IS NULL THEN
        RAISE EXCEPTION 'No se encontró el artículo de la comanda en esta sucursal.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.sales WHERE id = v_sale_id AND status = 'abierta'
    ) THEN
        RAISE EXCEPTION 'La mesa ya no está abierta.';
    END IF;

    DELETE FROM public.sale_items WHERE id = p_item_id;

    UPDATE public.sales
    SET total = COALESCE(
        (SELECT SUM(si.subtotal) FROM public.sale_items si WHERE si.sale_id = v_sale_id),
        0
    )
    WHERE id = v_sale_id AND status = 'abierta';

    SELECT row_to_json(s) INTO v_sale FROM public.sales s WHERE s.id = v_sale_id LIMIT 1;
    IF v_sale IS NULL THEN
        RAISE EXCEPTION 'No se pudo recuperar la mesa después de eliminar el artículo.';
    END IF;
    RETURN v_sale;
END;
$function$;

DROP FUNCTION IF EXISTS public.comanda_assign_driver(bigint, uuid, numeric);

CREATE FUNCTION public.comanda_assign_driver(p_branch_id bigint, p_sale_id bigint, p_driver_id uuid, p_delivery_fee numeric)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_name text;
  v_old_fee numeric;
  v_delta numeric;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  SELECT name INTO v_driver_name
  FROM public.drivers
  WHERE id = p_driver_id AND branch_id = p_branch_id AND active = true;

  IF v_driver_name IS NULL THEN
    RAISE EXCEPTION 'El repartidor seleccionado no existe, está inactivo o no pertenece a esta sucursal.';
  END IF;

  SELECT delivery_fee INTO v_old_fee
  FROM public.sales
  WHERE id = p_sale_id AND branch_id = p_branch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró el pedido en esta sucursal.';
  END IF;

  v_delta := COALESCE(p_delivery_fee, 0) - COALESCE(v_old_fee, 0);

  UPDATE public.sales
  SET driver_id = p_driver_id,
      driver_name = v_driver_name,
      delivery_fee = COALESCE(p_delivery_fee, 0),
      total = total + v_delta,
      delivery_status = 'en_camino'
  WHERE id = p_sale_id
    AND branch_id = p_branch_id
    AND is_delivery = true
    AND driver_id IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El pedido ya tiene repartidor asignado o no es a domicilio.';
  END IF;

  RETURN json_build_object(
    'driver_id', p_driver_id,
    'driver_name', v_driver_name,
    'delivery_fee', COALESCE(p_delivery_fee, 0)
  );
END;
$function$;

-- ==========================================================================
-- 2. Catálogo/inventario: firma igual, solo se agrega el guard.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.create_product(p_branch_id bigint, p_name text, p_category text, p_price numeric, p_employee_price numeric, p_active boolean, p_sort_order integer, p_stock numeric, p_cost_per_unit numeric DEFAULT NULL::numeric)
 RETURNS products
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row public.products;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF p_price IS NULL OR p_price <= 0 THEN
    RAISE EXCEPTION 'El precio del producto debe ser mayor a $0.';
  END IF;

  INSERT INTO public.products (name, category, price, employee_price, active, sort_order, stock, cost_per_unit, branch_id)
  VALUES (p_name, p_category, p_price, p_employee_price, COALESCE(p_active, true), COALESCE(p_sort_order, 0), p_stock, p_cost_per_unit, p_branch_id)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_product(p_branch_id bigint, p_id bigint, p_name text, p_category text, p_price numeric, p_employee_price numeric, p_active boolean, p_sort_order integer, p_stock numeric, p_cost_per_unit numeric DEFAULT NULL::numeric)
 RETURNS products
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row public.products;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF p_price IS NULL OR p_price <= 0 THEN
    RAISE EXCEPTION 'El precio del producto debe ser mayor a $0.';
  END IF;

  UPDATE public.products
  SET name = p_name, category = p_category, price = p_price, employee_price = p_employee_price,
      active = COALESCE(p_active, true), sort_order = COALESCE(p_sort_order, 0), stock = p_stock,
      cost_per_unit = p_cost_per_unit
  WHERE id = p_id AND branch_id = p_branch_id
  RETURNING * INTO v_row;
  IF v_row IS NULL THEN RAISE EXCEPTION 'No se encontró el producto % en esta sucursal', p_id; END IF;
  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.remove_product(p_branch_id bigint, p_id bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_in_use bigint;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró el producto % en esta sucursal', p_id;
  END IF;

  SELECT count(*) INTO v_in_use FROM public.sale_items WHERE ref_id = p_id AND item_type = 'product';

  IF v_in_use > 0 THEN
    UPDATE public.products SET active = false WHERE id = p_id AND branch_id = p_branch_id;
    RETURN json_build_object('deleted', false, 'deactivated', true);
  END IF;

  DELETE FROM public.products WHERE id = p_id AND branch_id = p_branch_id;
  RETURN json_build_object('deleted', true, 'deactivated', false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.adjust_product_stock(p_branch_id bigint, p_id bigint, p_delta numeric)
 RETURNS products
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row public.products;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  SELECT * INTO v_row FROM public.products WHERE id = p_id AND branch_id = p_branch_id;
  IF v_row IS NULL THEN RAISE EXCEPTION 'No se encontró el producto % en esta sucursal', p_id; END IF;
  IF v_row.stock IS NULL THEN RETURN v_row; END IF;

  UPDATE public.products SET stock = GREATEST(0, COALESCE(stock, 0) + p_delta)
  WHERE id = p_id AND branch_id = p_branch_id
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_modifier(p_branch_id bigint, p_id bigint, p_name text, p_inventory_id bigint, p_price_extra numeric, p_qty_needed numeric DEFAULT NULL::numeric)
 RETURNS modifiers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row public.modifiers;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  UPDATE public.modifiers
  SET name = COALESCE(p_name, name),
      inventory_id = COALESCE(p_inventory_id, inventory_id),
      price_extra = p_price_extra,
      qty_needed = COALESCE(p_qty_needed, qty_needed)
  WHERE id = p_id AND branch_id = p_branch_id
  RETURNING * INTO v_row;
  IF v_row IS NULL THEN RAISE EXCEPTION 'No se encontró el modificador % en esta sucursal', p_id; END IF;
  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_promotion(
  p_branch_id bigint, p_name text, p_description text, p_price numeric, p_active boolean, p_applicable_category text
) RETURNS public.promotions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.promotions;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch_id) THEN
    RAISE EXCEPTION 'La sucursal % no existe.', p_branch_id;
  END IF;

  IF p_price IS NULL OR p_price <= 0 THEN
    RAISE EXCEPTION 'El precio de la promoción debe ser mayor a $0.';
  END IF;

  INSERT INTO public.promotions (name, description, price, active, applicable_category, branch_id)
  VALUES (p_name, COALESCE(p_description, ''), p_price, COALESCE(p_active, true), p_applicable_category, p_branch_id)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_promotion(p_branch_id bigint, p_id bigint, p_name text, p_description text, p_price numeric, p_active boolean, p_applicable_category text)
 RETURNS promotions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.promotions;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF p_price IS NULL OR p_price <= 0 THEN
    RAISE EXCEPTION 'El precio de la promoción debe ser mayor a $0.';
  END IF;

  UPDATE public.promotions
  SET name = p_name,
      description = COALESCE(p_description, ''),
      price = p_price,
      active = COALESCE(p_active, true),
      applicable_category = p_applicable_category
  WHERE id = p_id AND branch_id = p_branch_id
  RETURNING * INTO v_row;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'No se encontró la promoción % en esta sucursal', p_id;
  END IF;
  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_recipes_for_product(p_branch_id bigint, p_product_id bigint, p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row jsonb; v_count integer := 0;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró el producto % en esta sucursal', p_product_id;
  END IF;

  DELETE FROM public.recipes WHERE product_id = p_product_id AND branch_id = p_branch_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) LOOP
    IF (v_row->>'insumo_id') IS NULL OR COALESCE((v_row->>'quantity_needed')::numeric, 0) <= 0 THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.inventory WHERE id = (v_row->>'insumo_id')::bigint AND branch_id = p_branch_id) THEN
      RAISE EXCEPTION 'El insumo % no pertenece a esta sucursal', v_row->>'insumo_id';
    END IF;
    INSERT INTO public.recipes (product_id, insumo_id, quantity_needed, branch_id)
    VALUES (p_product_id, (v_row->>'insumo_id')::bigint, (v_row->>'quantity_needed')::numeric, p_branch_id);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_components_for_product(p_branch_id bigint, p_product_id bigint, p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row jsonb; v_count integer := 0;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró el producto % en esta sucursal', p_product_id;
  END IF;

  DELETE FROM public.product_components WHERE parent_product_id = p_product_id AND branch_id = p_branch_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) LOOP
    IF (v_row->>'component_product_id') IS NULL
       OR (v_row->>'component_product_id')::bigint = p_product_id
       OR COALESCE((v_row->>'qty')::numeric, 0) <= 0
    THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = (v_row->>'component_product_id')::bigint AND branch_id = p_branch_id) THEN
      RAISE EXCEPTION 'El componente % no pertenece a esta sucursal', v_row->>'component_product_id';
    END IF;
    INSERT INTO public.product_components (parent_product_id, component_product_id, qty, branch_id)
    VALUES (p_product_id, (v_row->>'component_product_id')::bigint, (v_row->>'qty')::numeric, p_branch_id);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_product_modifier_group(p_branch_id bigint, p_product_id bigint, p_group_name text, p_enabled boolean, p_qty integer DEFAULT 1)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró el producto % en esta sucursal', p_product_id;
  END IF;

  DELETE FROM public.product_modifier_groups WHERE product_id = p_product_id AND group_name = p_group_name;

  IF p_enabled THEN
    INSERT INTO public.product_modifier_groups (product_id, group_name, qty, branch_id)
    VALUES (p_product_id, p_group_name, GREATEST(1, COALESCE(p_qty, 1)), p_branch_id);
  END IF;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_kds_status(p_branch_id bigint, p_sale_id bigint, p_status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_client_type text;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF p_status NOT IN ('nueva', 'en_preparacion', 'lista', 'entregada') THEN
    RAISE EXCEPTION 'Estado de KDS inválido: %', p_status;
  END IF;

  IF p_status = 'entregada' THEN
    SELECT client_type INTO v_client_type
    FROM public.sales
    WHERE id = p_sale_id AND branch_id = p_branch_id;
  END IF;

  UPDATE public.sales
  SET kds_status = p_status,
      kds_started_at = CASE WHEN p_status = 'en_preparacion' THEN now() ELSE kds_started_at END,
      kds_ready_at = CASE WHEN p_status = 'lista' THEN now() ELSE kds_ready_at END,
      kds_delivered_at = CASE WHEN p_status = 'entregada' THEN now() ELSE kds_delivered_at END,
      status = CASE WHEN p_status = 'entregada' AND v_client_type = 'Llevar' THEN 'completada' ELSE status END
  WHERE id = p_sale_id
    AND branch_id = p_branch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró la orden % en esta sucursal', p_sale_id;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.migrate_alitas_boneless_categories(p_branch_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;
  RETURN;
END; $function$;

-- ==========================================================================
-- 3. Lecturas MEDIO -- mismo patrón NULL-safe de 20260822260000.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.get_products_by_branch(p_branch_id bigint)
 RETURNS SETOF products
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (p_branch_id = ANY (COALESCE(public.current_visible_branch_ids(), ARRAY[]::bigint[]))) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;
  RETURN QUERY SELECT * FROM public.products WHERE branch_id = p_branch_id ORDER BY category, sort_order, name;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_menu_by_branch(p_branch_id bigint)
 RETURNS TABLE(product_id integer, product_name character varying, price numeric, category text, branch_id bigint)
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
  SELECT id, name, price, category, branch_id
  FROM products
  WHERE branch_id = p_branch_id AND active = true
  ORDER BY sort_order;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_modifiers_by_branch(p_branch_id bigint)
 RETURNS SETOF modifiers
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (p_branch_id = ANY (COALESCE(public.current_visible_branch_ids(), ARRAY[]::bigint[]))) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;
  RETURN QUERY SELECT * FROM modifiers WHERE branch_id = p_branch_id AND active = true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_product_modifier_groups_by_branch(p_branch_id bigint)
 RETURNS SETOF product_modifier_groups
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (p_branch_id = ANY (COALESCE(public.current_visible_branch_ids(), ARRAY[]::bigint[]))) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;
  RETURN QUERY SELECT * FROM public.product_modifier_groups WHERE branch_id = p_branch_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_components_for_product(p_branch_id bigint, p_product_id bigint)
 RETURNS TABLE(id bigint, parent_product_id bigint, component_product_id bigint, qty numeric, component_name text, component_price numeric)
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
  SELECT pc.id, pc.parent_product_id, pc.component_product_id, pc.qty, c.name, c.price
  FROM public.product_components pc
  JOIN public.products c ON c.id = pc.component_product_id
  WHERE pc.branch_id = p_branch_id AND pc.parent_product_id = p_product_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_all_product_components_by_branch(p_branch_id bigint)
 RETURNS TABLE(id bigint, parent_product_id bigint, parent_name text, component_product_id bigint, component_name text, qty numeric)
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
  SELECT pc.id, pc.parent_product_id, p.name, pc.component_product_id, c.name, pc.qty
  FROM public.product_components pc
  JOIN public.products p ON p.id = pc.parent_product_id
  JOIN public.products c ON c.id = pc.component_product_id
  WHERE pc.branch_id = p_branch_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_recipes_for_product(p_branch_id bigint, p_product_id bigint)
 RETURNS TABLE(id bigint, product_id bigint, insumo_id bigint, quantity_needed numeric, insumo_name text, insumo_unit text, insumo_stock numeric, insumo_cost_per_unit numeric)
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
  SELECT r.id, r.product_id, r.insumo_id, r.quantity_needed, i.name, i.unit, i.stock, i.cost_per_unit
  FROM public.recipes r
  JOIN public.inventory i ON i.id = r.insumo_id
  WHERE r.branch_id = p_branch_id AND r.product_id = p_product_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_all_recipes_with_stock(p_branch_id bigint)
 RETURNS TABLE(product_id bigint, product_name text, insumo_id bigint, insumo_name text, insumo_unit text, insumo_stock numeric, insumo_min_stock numeric, quantity_needed numeric)
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
  SELECT r.product_id, p.name, r.insumo_id, i.name, i.unit, i.stock, i.min_stock, r.quantity_needed
  FROM public.recipes r
  JOIN public.products p ON p.id = r.product_id
  JOIN public.inventory i ON i.id = r.insumo_id
  WHERE r.branch_id = p_branch_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_product_ids_with_recipe(p_branch_id bigint)
 RETURNS TABLE(product_id bigint)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (p_branch_id = ANY (COALESCE(public.current_visible_branch_ids(), ARRAY[]::bigint[]))) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;
  RETURN QUERY SELECT DISTINCT product_id FROM public.recipes WHERE branch_id = p_branch_id;
END;
$function$;

-- ==========================================================================
-- 4. Recreación de las 12 MEDIO que no existían en vivo -- guard incluido
--    desde el origen, misma lógica que su migración original.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.remove_promotion(p_branch_id bigint, p_id bigint)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_in_use bigint;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.promotions WHERE id = p_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró la promoción % en esta sucursal', p_id;
  END IF;

  SELECT count(*) INTO v_in_use FROM public.sale_items WHERE ref_id = p_id AND item_type = 'promo';

  IF v_in_use > 0 THEN
    UPDATE public.promotions SET active = false WHERE id = p_id AND branch_id = p_branch_id;
    RETURN json_build_object('deleted', false, 'deactivated', true);
  END IF;

  DELETE FROM public.promotions WHERE id = p_id AND branch_id = p_branch_id;
  RETURN json_build_object('deleted', true, 'deactivated', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_inventory_item(
  p_branch_id bigint, p_name text, p_category text, p_unit text,
  p_stock numeric, p_min_stock numeric, p_cost_per_unit numeric, p_created_by text
) RETURNS public.inventory
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.inventory;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'El nombre del insumo es obligatorio.';
  END IF;
  IF COALESCE(p_stock, 0) < 0 THEN
    RAISE EXCEPTION 'La existencia inicial no puede ser negativa.';
  END IF;

  BEGIN
    INSERT INTO public.inventory (name, category, unit, stock, min_stock, cost_per_unit, branch_id)
    VALUES (btrim(p_name), p_category, COALESCE(p_unit, 'pz'), COALESCE(p_stock, 0), COALESCE(p_min_stock, 0), COALESCE(p_cost_per_unit, 0), p_branch_id)
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Ya existe un insumo llamado "%".', p_name;
  END;

  IF COALESCE(p_stock, 0) > 0 THEN
    INSERT INTO public.inventory_movements (insumo_id, type, quantity, reason, created_by)
    VALUES (v_row.id, 'entrada', p_stock, 'Alta de insumo - existencia inicial', p_created_by);
  END IF;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_inventory_item(
  p_branch_id bigint, p_id bigint, p_name text, p_category text, p_unit text,
  p_stock numeric, p_min_stock numeric, p_cost_per_unit numeric, p_created_by text
) RETURNS public.inventory
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before public.inventory;
  v_row public.inventory;
  v_delta numeric;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'El nombre del insumo es obligatorio.';
  END IF;
  IF COALESCE(p_stock, 0) < 0 THEN
    RAISE EXCEPTION 'La existencia no puede ser negativa.';
  END IF;

  SELECT * INTO v_before FROM public.inventory WHERE id = p_id AND branch_id = p_branch_id;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'No se encontró el insumo % en esta sucursal', p_id;
  END IF;

  BEGIN
    UPDATE public.inventory
    SET name = btrim(p_name), category = p_category, unit = COALESCE(p_unit, 'pz'),
        stock = COALESCE(p_stock, 0), min_stock = COALESCE(p_min_stock, 0),
        cost_per_unit = COALESCE(p_cost_per_unit, 0), updated_at = now()
    WHERE id = p_id AND branch_id = p_branch_id
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Ya existe un insumo llamado "%".', p_name;
  END;

  v_delta := COALESCE(p_stock, 0) - COALESCE(v_before.stock, 0);
  IF v_delta <> 0 THEN
    INSERT INTO public.inventory_movements (insumo_id, type, quantity, reason, created_by)
    VALUES (p_id, 'ajuste', v_delta, 'Ajuste manual desde edición de insumo', p_created_by);
  END IF;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_inventory_item(p_branch_id bigint, p_id bigint)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.inventory WHERE id = p_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró el insumo % en esta sucursal', p_id;
  END IF;

  UPDATE public.waste SET inventory_id = NULL WHERE inventory_id = p_id;
  DELETE FROM public.inventory WHERE id = p_id AND branch_id = p_branch_id;
  RETURN json_build_object('deleted', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.add_inventory_stock(
  p_branch_id bigint, p_id bigint, p_quantity numeric, p_cost_per_unit numeric, p_reason text, p_created_by text
) RETURNS public.inventory
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item public.inventory;
  v_row public.inventory;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'La cantidad a agregar debe ser mayor que cero.';
  END IF;

  SELECT * INTO v_item FROM public.inventory WHERE id = p_id AND branch_id = p_branch_id;
  IF v_item IS NULL THEN
    RAISE EXCEPTION 'No se encontró el insumo % en esta sucursal', p_id;
  END IF;

  UPDATE public.inventory
  SET stock = COALESCE(stock, 0) + p_quantity,
      cost_per_unit = CASE WHEN p_cost_per_unit IS NOT NULL THEN p_cost_per_unit ELSE cost_per_unit END,
      updated_at = now()
  WHERE id = p_id AND branch_id = p_branch_id
  RETURNING * INTO v_row;

  INSERT INTO public.inventory_movements (insumo_id, type, quantity, reason, created_by)
  VALUES (p_id, 'entrada', p_quantity, COALESCE(p_reason, 'Compra'), p_created_by);

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_cost(
  p_branch_id bigint, p_concept text, p_category text, p_amount numeric, p_date date, p_metodo_pago text DEFAULT NULL
) RETURNS public.costs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.costs;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

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
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  DELETE FROM public.costs WHERE id = p_id AND branch_id = p_branch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró el gasto % en esta sucursal', p_id;
  END IF;
  RETURN json_build_object('deleted', true);
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
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

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
  p_branch_id bigint, p_inventory_id bigint, p_item_name text, p_quantity numeric,
  p_unit text, p_reason text, p_cost numeric, p_tipo text, p_autorizado_por text
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
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

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

CREATE OR REPLACE FUNCTION public.comanda_add_item_with_modifiers(
  p_branch_id bigint, p_sale_id bigint, p_ref_id bigint, p_item_type text, p_name text,
  p_unit_price numeric, p_quantity numeric, p_modifier_ids bigint[] DEFAULT NULL, p_notes text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_item_id bigint;
  v_modifier_id bigint;
  v_total numeric;
  v_sale json;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.sales
    WHERE id = p_sale_id AND branch_id = p_branch_id AND status = 'abierta'
  ) THEN
    RAISE EXCEPTION 'La mesa % no está abierta en esta sucursal', p_sale_id;
  END IF;

  INSERT INTO public.sale_items (sale_id, ref_id, item_type, name, unit_price, quantity, subtotal, notes)
  VALUES (p_sale_id, p_ref_id, COALESCE(p_item_type, 'product'), p_name, p_unit_price, p_quantity, p_unit_price * p_quantity, p_notes)
  RETURNING id INTO v_new_item_id;

  IF p_modifier_ids IS NOT NULL THEN
    FOREACH v_modifier_id IN ARRAY p_modifier_ids LOOP
      INSERT INTO public.sale_item_modifiers (sale_item_id, modifier_id)
      VALUES (v_new_item_id, v_modifier_id);
    END LOOP;
  END IF;

  SELECT COALESCE(SUM(subtotal), 0) INTO v_total FROM public.sale_items WHERE sale_id = p_sale_id;
  UPDATE public.sales SET total = v_total WHERE id = p_sale_id;

  SELECT row_to_json(s) INTO v_sale FROM public.sales s WHERE s.id = p_sale_id;
  RETURN v_sale;
END;
$$;

CREATE OR REPLACE FUNCTION public.comanda_update_delivery_status(p_branch_id bigint, p_sale_id bigint, p_status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF p_status NOT IN ('en_camino', 'entregado') THEN
    RAISE EXCEPTION 'Estado de entrega inválido: %', p_status;
  END IF;

  UPDATE public.sales
  SET delivery_status = p_status,
      status = CASE WHEN p_status = 'entregado' THEN 'completada' ELSE status END,
      payment_status = CASE WHEN p_status = 'entregado' THEN 'dinero_con_repartidor' ELSE payment_status END
  WHERE id = p_sale_id
    AND branch_id = p_branch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró la venta % en esta sucursal', p_sale_id;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_sale_cashier(p_branch_id bigint, p_sale_id bigint, p_cashier_user_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  UPDATE public.sales
  SET cashier_user_id = p_cashier_user_id
  WHERE id = p_sale_id
    AND branch_id = p_branch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró la venta % en esta sucursal', p_sale_id;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_sale_item_notes_and_modifiers(
  p_branch_id bigint, p_sale_item_id bigint, p_notes text, p_modifier_ids bigint[]
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_modifier_id bigint;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.sale_items si
    JOIN public.sales s ON s.id = si.sale_id
    WHERE si.id = p_sale_item_id AND s.branch_id = p_branch_id
  ) THEN
    RAISE EXCEPTION 'No se encontró el renglón % en esta sucursal', p_sale_item_id;
  END IF;

  IF p_notes IS NOT NULL THEN
    UPDATE public.sale_items SET notes = p_notes WHERE id = p_sale_item_id;
  END IF;

  IF p_modifier_ids IS NOT NULL THEN
    FOREACH v_modifier_id IN ARRAY p_modifier_ids LOOP
      INSERT INTO public.sale_item_modifiers (sale_item_id, modifier_id)
      VALUES (p_sale_item_id, v_modifier_id);
    END LOOP;
  END IF;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_sale_printed(p_branch_id bigint, p_sale_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  UPDATE public.sales
  SET printed = true
  WHERE id = p_sale_id
    AND branch_id = p_branch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró la venta % en esta sucursal', p_sale_id;
  END IF;
  RETURN true;
END;
$$;

-- ==========================================================================
-- 5. Permisos: REVOKE explícito de PUBLIC y anon (defensa en profundidad,
--    ver 20260822260000/270000 -- toda función recién CREATE-ada u
--    obtenida vía DROP+CREATE queda con EXECUTE para anon automático que
--    hay que quitar a mano) + GRANT a authenticated para las ~40.
-- ==========================================================================
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.comanda_open_table(bigint, integer, text)',
    'public.comanda_open_takeout(bigint, text)',
    'public.comanda_add_item(bigint, bigint, integer, text, text, numeric, integer)',
    'public.comanda_update_item_qty(bigint, bigint, integer)',
    'public.comanda_remove_item(bigint, bigint)',
    'public.comanda_assign_driver(bigint, bigint, uuid, numeric)',
    'public.create_product(bigint, text, text, numeric, numeric, boolean, integer, numeric, numeric)',
    'public.update_product(bigint, bigint, text, text, numeric, numeric, boolean, integer, numeric, numeric)',
    'public.remove_product(bigint, bigint)',
    'public.adjust_product_stock(bigint, bigint, numeric)',
    'public.update_modifier(bigint, bigint, text, bigint, numeric, numeric)',
    'public.create_promotion(bigint, text, text, numeric, boolean, text)',
    'public.update_promotion(bigint, bigint, text, text, numeric, boolean, text)',
    'public.remove_promotion(bigint, bigint)',
    'public.set_recipes_for_product(bigint, bigint, jsonb)',
    'public.set_components_for_product(bigint, bigint, jsonb)',
    'public.set_product_modifier_group(bigint, bigint, text, boolean, integer)',
    'public.update_kds_status(bigint, bigint, text)',
    'public.migrate_alitas_boneless_categories(bigint)',
    'public.get_products_by_branch(bigint)',
    'public.get_menu_by_branch(bigint)',
    'public.get_modifiers_by_branch(bigint)',
    'public.get_product_modifier_groups_by_branch(bigint)',
    'public.get_components_for_product(bigint, bigint)',
    'public.get_all_product_components_by_branch(bigint)',
    'public.get_recipes_for_product(bigint, bigint)',
    'public.get_all_recipes_with_stock(bigint)',
    'public.get_product_ids_with_recipe(bigint)',
    'public.create_inventory_item(bigint, text, text, text, numeric, numeric, numeric, text)',
    'public.update_inventory_item(bigint, bigint, text, text, text, numeric, numeric, numeric, text)',
    'public.remove_inventory_item(bigint, bigint)',
    'public.add_inventory_stock(bigint, bigint, numeric, numeric, text, text)',
    'public.create_cost(bigint, text, text, numeric, date, text)',
    'public.remove_cost(bigint, bigint)',
    'public.create_driver(bigint, text, text)',
    'public.create_waste_entry(bigint, bigint, text, numeric, text, text, numeric, text, text)',
    'public.comanda_add_item_with_modifiers(bigint, bigint, bigint, text, text, numeric, numeric, bigint[], text)',
    'public.comanda_update_delivery_status(bigint, bigint, text)',
    'public.set_sale_cashier(bigint, bigint, bigint)',
    'public.set_sale_item_notes_and_modifiers(bigint, bigint, text, bigint[])',
    'public.mark_sale_printed(bigint, bigint)'
  ]
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $$;

-- ==========================================================================
-- 6. Limpieza de las funciones temporales de introspección de Fase 2C.
-- ==========================================================================
DROP FUNCTION IF EXISTS public.tmp_introspect_fase2c_defs();
DROP FUNCTION IF EXISTS public.tmp_introspect_fase2c_missing();
DROP FUNCTION IF EXISTS public.tmp_introspect_still_anon();
DROP FUNCTION IF EXISTS public.tmp_debug_acl(text);

-- Fix puntual encontrado durante la verificación de Fase 2C: get_branch_kds_secret
-- (del hotfix 20260822190000) seguía con EXECUTE directo para anon en su
-- proacl real (confirmado con pg_proc.proacl) -- nunca se le hizo REVOKE
-- explícito de anon en ninguna migración anterior (solo de PUBLIC, que es
-- una entrada de ACL distinta). El guard interno la protegía igual (NULL-safe
-- desde 20260822260000), pero el permiso de base de datos debe ser la
-- primera barrera, no la única.
REVOKE EXECUTE ON FUNCTION public.get_branch_kds_secret(bigint) FROM anon;
