-- Limpieza de las ventas sintéticas usadas para probar en vivo el flujo
-- domicilio -> asignar repartidor -> entregar -> liquidar (folios
-- 20260819-0001 y 20260819-0002, opened_by = 'TEST-DELIVERY-FLOW'). No
-- afecta datos reales de negocio -- mismo patrón que
-- 20260815040200_cleanup_verification_test_sale.sql.
--
-- La venta 105 quedó a medias a propósito: es evidencia en vivo del bug de
-- overloads ambiguos que corrige 20260819070000 (process_sale se ejecutó
-- bien, pero comanda_set_delivery falló después, así que se quedó como un
-- "Llevar" abierto sin is_delivery). La 106 sí completó el flujo entero.
DELETE FROM public.sale_items
 WHERE sale_id IN (
   SELECT id FROM public.sales
   WHERE opened_by = 'TEST-DELIVERY-FLOW'
     AND folio IN ('20260819-0001', '20260819-0002')
 );

DELETE FROM public.sales
 WHERE opened_by = 'TEST-DELIVERY-FLOW'
   AND folio IN ('20260819-0001', '20260819-0002');
