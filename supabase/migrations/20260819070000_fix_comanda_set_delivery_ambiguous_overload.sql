-- BUG CRÍTICO PREEXISTENTE, descubierto al probar en vivo el flujo de
-- domicilio (no lo causó la migración anterior 20260819050000): la base de
-- datos tenía en realidad TRES funciones llamadas comanda_set_delivery,
-- ninguna documentada salvo la de 6 parámetros que sí está en
-- wing-house-web/supabase/migrations/0004_delivery_orders.sql:
--
--   1. comanda_set_delivery(p_customer_name, p_customer_phone,
--      p_delivery_address, p_delivery_fee, p_driver_name, p_sale_id,
--      p_is_delivery DEFAULT true) -- versión primitiva sin SECURITY
--      DEFINER search_path fijo y sin validar client_type = 'Llevar'.
--      Nada en este repo ni en wing-house-web la llama con los 7 argumentos.
--   2. comanda_set_delivery(p_sale_id bigint) -- pone status = 'en_camino'
--      (¡la columna equivocada, no delivery_status!). Nada la llama.
--   3. comanda_set_delivery(p_sale_id, p_customer_name, p_customer_phone,
--      p_delivery_address, p_delivery_fee, p_driver_name) -- la real, la
--      que SÍ llama wing-house-web/src/components/comandas.jsx (con
--      exactamente estos 6 argumentos nombrados) y la que actualiza
--      20260819050000 para agregar payment_status.
--
-- Como el overload #1 tiene p_is_delivery con DEFAULT, Postgres no puede
-- decidir entre el #1 y el #3 cuando alguien llama la función con los mismos
-- 6 nombres que usa la web -- "Could not choose the best candidate function".
-- Es decir: TODA venta a domicilio creada desde la web fallaba al guardar
-- domicilio/dirección/repartidor/envío desde que existe el overload #1 (la
-- venta se crea bien vía process_sale, pero comanda_set_delivery truena
-- después, así que se queda como un "Llevar" normal sin ningún dato de
-- domicilio -- exactamente el tipo de pérdida de trazabilidad que reporta
-- el bug original). Se descubrió al reproducir el flujo completo en vivo
-- para esta tarea.
--
-- Fix: eliminar los dos overloads muertos (#1 y #2) para que la llamada de
-- la web vuelva a resolver sin ambigüedad al overload real (#3).
DROP FUNCTION IF EXISTS public.comanda_set_delivery(text, text, text, numeric, text, bigint, boolean);
DROP FUNCTION IF EXISTS public.comanda_set_delivery(bigint);

-- Limpieza: función temporal de introspección de
-- 20260819060000_tmp_introspect_comanda_set_delivery.sql, ya no se necesita.
DROP FUNCTION IF EXISTS public.tmp_introspect_delivery_fns();
