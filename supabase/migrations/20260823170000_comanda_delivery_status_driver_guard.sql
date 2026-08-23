-- Auditoría de Comandas 2026-08-23: comanda_update_delivery_status podía
-- marcar un pedido a domicilio como 'entregado' (status='completada',
-- payment_status='dinero_con_repartidor') sin que la venta tuviera
-- repartidor asignado (driver_id NULL). La única barrera era del lado
-- cliente -- comandas-renderer.js:374 solo pinta el botón "Entregada"
-- cuando o.driver_id ya existe -- pero el RPC en sí (GRANT a authenticated)
-- no lo exige. Efecto real: cualquier sesión autenticada de esa sucursal
-- (o una llamada directa por REST) podía cerrar un pedido a domicilio como
-- pagado/entregado sin que nadie -- ni un repartidor real -- hubiera tocado
-- la puerta del cliente, exactamente el escenario de "completar sin pago"
-- que el usuario pidió verificar. Fix: exige driver_id IS NOT NULL antes de
-- aceptar 'entregado', igual que mesa/para llevar ya exigen método de pago
-- válido en close_table. No se toca el resto de la función (branch check,
-- 'en_camino' sigue permitido sin repartidor porque hoy nada lo llama con
-- ese valor -- comanda_assign_driver lo pone directo -- así que no hay
-- caller real que romper).

CREATE OR REPLACE FUNCTION public.comanda_update_delivery_status(p_branch_id bigint, p_sale_id bigint, p_status text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid;
BEGIN
  IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  IF p_status NOT IN ('en_camino', 'entregado') THEN
    RAISE EXCEPTION 'Estado de entrega inválido: %', p_status;
  END IF;

  IF p_status = 'entregado' THEN
    SELECT driver_id INTO v_driver_id
    FROM public.sales
    WHERE id = p_sale_id AND branch_id = p_branch_id;

    IF v_driver_id IS NULL THEN
      RAISE EXCEPTION 'No se puede marcar como entregado un pedido sin repartidor asignado.';
    END IF;
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
$function$;
