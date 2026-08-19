-- Ejecuta este archivo COMPLETO en Supabase Dashboard > SQL Editor.
--
-- BUG DE DINERO: el botón "Entregado" (comandaSetDeliveryStatus, ver
-- comandas-renderer.js) marca la venta como completada -- y getCorteResumen
-- (db.js) suma TODO lo 'completada' como si ya estuviera en el cajón -- en
-- el mismo instante en que el repartidor SALE con la comida. En domicilio el
-- repartidor cobra en casa del cliente y regresa después con el efectivo: el
-- corte de caja se descuadra porque cuenta dinero que físicamente sigue en
-- la calle.
--
-- Este archivo NO reemplaza el modelo de domicilio que ya existe (is_delivery
-- / customer_name / delivery_address / delivery_fee / driver_name /
-- delivery_status, ver wing-house-web/supabase/migrations/0004_delivery_orders.sql
-- y 20260816010000_process_sale_delivery_open.sql) -- la web sigue creando
-- pedidos a domicilio exactamente igual. Le agrega una dimensión NUEVA y
-- ortogonal, payment_status, que separa "¿ya se entregó el pedido?"
-- (delivery_status) de "¿el dinero de ese pedido ya está físicamente en el
-- local?" (payment_status). Antes esas dos preguntas eran la misma
-- (status = 'completada'); ahora no.
--
-- Línea de tiempo de un domicilio:
--   1. Web crea el pedido (process_sale + comanda_set_delivery).
--      payment_status = 'pendiente' (nadie ha cobrado nada todavía).
--   2. Escritorio asigna repartidor (comanda_assign_driver, función nueva).
--      delivery_status = 'en_camino'. payment_status sigue 'pendiente': el
--      repartidor va cargando la comida, no ha cobrado nada aún.
--   3. Escritorio marca "Entregado" (comandaSetDeliveryStatus, ya existía,
--      solo se le agrega una columna al UPDATE). Aquí es cuando el
--      repartidor cobra en la puerta del cliente: delivery_status =
--      'entregado' Y payment_status = 'dinero_con_repartidor' -- el dinero
--      existe, pero está en la bolsa del repartidor, no en el cajón.
--   4. Repartidor regresa al local y entrega el efectivo de la comida (se
--      queda con el envío). Caja liquida (liquidate_driver_sales, función
--      nueva): payment_status = 'liquidado', paid_at = now().
--
-- getCorteResumen ahora solo debe sumar payment_status IN ('pagado_en_caja',
-- 'liquidado') -- nunca 'dinero_con_repartidor', porque ese efectivo todavía
-- no está en el local (ver cambio en db.js).
--
-- Ventas que NO son domicilio (mesa, para llevar, mostrador, empleado) siguen
-- exactamente igual que hoy: el cliente paga en el momento en que la venta se
-- cierra, así que el DEFAULT de la columna es 'pagado_en_caja' -- ningún
-- flujo existente tiene que tocarse ni dejar de aparecer en el corte.

-- ============================================================
-- 1. TABLA drivers
-- ============================================================
CREATE TABLE IF NOT EXISTS public.drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text,
  active bool NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.drivers ENABLE ROW LEVEL SECURITY;

-- El escritorio usa la anon key sin sesión de Supabase Auth (ver
-- supabaseClient.js) para TODO, igual que sales/waste/settings/payroll_weeks
-- (ver 20260815040000_rls_allow_anon_promotions_inventory_costs_attendance.sql
-- y 20260817030000_payroll_weeks_rls_policy.sql) -- sin esta policy,
-- getDrivers()/createDriver() devolverían vacío o fallarían en silencio.
DROP POLICY IF EXISTS "allow_anon_all" ON public.drivers;
CREATE POLICY "allow_anon_all" ON public.drivers FOR ALL USING (true) WITH CHECK (true);

-- Seed: solo si la tabla está vacía (instalación nueva). No pisa nombres
-- reales si alguien ya la llenó a mano.
INSERT INTO public.drivers (name)
SELECT v.name FROM (VALUES ('Repartidor 1'), ('Repartidor 2')) AS v(name)
WHERE NOT EXISTS (SELECT 1 FROM public.drivers);

-- ============================================================
-- 2. COLUMNAS NUEVAS EN sales
-- ============================================================
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS driver_id uuid REFERENCES public.drivers(id);

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'pagado_en_caja';

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;

ALTER TABLE public.sales
  DROP CONSTRAINT IF EXISTS sales_payment_status_check;

ALTER TABLE public.sales
  ADD CONSTRAINT sales_payment_status_check
  CHECK (payment_status IN ('pendiente', 'pagado_en_caja', 'dinero_con_repartidor', 'liquidado'));

-- Backfill: el DEFAULT 'pagado_en_caja' ya rellenó todas las filas
-- existentes (incluidas las domicilio ya cerradas hace tiempo -- son
-- historial ya cuadrado, no hay nada que reconciliar ahí). El único caso que
-- ese default deja mal es un domicilio que a la hora de correr esta
-- migración sigue EN CURSO (status = 'abierta', is_delivery = true): a esos
-- el dinero todavía no se les ha cobrado, así que deben arrancar en
-- 'pendiente', no 'pagado_en_caja'. No afecta el corte de caja de hoy
-- (getCorteResumen solo mira status = 'completada'), es higiene de datos
-- para que la tarjeta en Comandas nazca en el estado correcto.
UPDATE public.sales
   SET payment_status = 'pendiente'
 WHERE is_delivery = true
   AND status = 'abierta'
   AND payment_status = 'pagado_en_caja';

CREATE INDEX IF NOT EXISTS idx_sales_driver_pending_money
  ON public.sales (driver_id)
  WHERE payment_status = 'dinero_con_repartidor';

-- ============================================================
-- 3. comanda_set_delivery: ahora también arranca payment_status = 'pendiente'
--    (mismo nombre/firma que la versión original -- CREATE OR REPLACE la
--    sustituye en su lugar, no crea un overload).
-- ============================================================
CREATE OR REPLACE FUNCTION public.comanda_set_delivery(
  p_sale_id bigint,
  p_customer_name text,
  p_customer_phone text,
  p_delivery_address text,
  p_delivery_fee numeric,
  p_driver_name text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    AND client_type = 'Llevar';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró una venta "Llevar" con id %', p_sale_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.comanda_set_delivery(bigint, text, text, text, numeric, text) TO authenticated;

-- ============================================================
-- 4. comanda_assign_driver: asigna repartidor desde el escritorio (drivers
--    estructurado, no el texto libre driver_name que llena la web) y manda
--    el pedido a "en_camino". No toca payment_status -- el repartidor sale
--    con la comida, todavía no ha cobrado nada (eso pasa hasta "Entregado").
--    Denormaliza driver_name en la misma fila para no romper el código ya
--    existente que lee sale.driver_name directo (ticket/historial/tarjeta).
-- ============================================================
CREATE OR REPLACE FUNCTION public.comanda_assign_driver(
  p_sale_id bigint,
  p_driver_id uuid,
  p_delivery_fee numeric
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_driver_name text;
  v_old_fee numeric;
  v_delta numeric;
BEGIN
  SELECT name INTO v_driver_name
  FROM public.drivers
  WHERE id = p_driver_id AND active = true;

  IF v_driver_name IS NULL THEN
    RAISE EXCEPTION 'El repartidor seleccionado no existe o está inactivo.';
  END IF;

  SELECT delivery_fee INTO v_old_fee
  FROM public.sales
  WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontró el pedido.';
  END IF;

  -- El envío puede venir ya cargado al total desde la web
  -- (comanda_set_delivery). Solo se suma la diferencia contra lo que ya
  -- había, para no duplicar el cobro del envío si el monto no cambió.
  v_delta := COALESCE(p_delivery_fee, 0) - COALESCE(v_old_fee, 0);

  UPDATE public.sales
  SET driver_id = p_driver_id,
      driver_name = v_driver_name,
      delivery_fee = COALESCE(p_delivery_fee, 0),
      total = total + v_delta,
      delivery_status = 'en_camino'
  WHERE id = p_sale_id
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
$$;

GRANT EXECUTE ON FUNCTION public.comanda_assign_driver(bigint, uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.comanda_assign_driver(bigint, uuid, numeric) TO anon;

-- ============================================================
-- 5. liquidate_driver_sales: caja recibe el efectivo de la comida que trae
--    el repartidor (se quedó con el envío desde que se lo entregaron). Una
--    sola sentencia UPDATE = una sola transacción implícita: o se liquidan
--    todos los pedidos pendientes de ese repartidor, o ninguno.
-- ============================================================
CREATE OR REPLACE FUNCTION public.liquidate_driver_sales(p_driver_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
  v_total numeric;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(total - delivery_fee), 0)
  INTO v_count, v_total
  FROM public.sales
  WHERE driver_id = p_driver_id
    AND payment_status = 'dinero_con_repartidor';

  UPDATE public.sales
  SET payment_status = 'liquidado',
      paid_at = now()
  WHERE driver_id = p_driver_id
    AND payment_status = 'dinero_con_repartidor';

  RETURN json_build_object('count', v_count, 'total', v_total);
END;
$$;

GRANT EXECUTE ON FUNCTION public.liquidate_driver_sales(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.liquidate_driver_sales(uuid) TO anon;
