-- Limpieza de la venta sintética usada para verificar en vivo que
-- close_table ya no truena por columnas inexistentes (folio 20260815-0004,
-- mesa de prueba 9998). No afecta datos reales de negocio.
DELETE FROM public.sale_items WHERE sale_id = 66;
DELETE FROM public.sales WHERE id = 66 AND folio = '20260815-0004';
