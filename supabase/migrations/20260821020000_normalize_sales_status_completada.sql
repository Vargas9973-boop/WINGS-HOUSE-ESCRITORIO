-- Higiene defensiva, no un fix de un bug confirmado: toda RPC de venta en
-- este repo (process_sale, comanda_close_table, etc. -- ver
-- 20260820020000_rpc_branch_id_core_sales.sql) escribe status='completada'
-- (español); no se encontró ningún camino que escriba 'completed'/'completado'.
-- Se deja este UPDATE por si hay filas de una versión anterior del sistema o
-- de una importación externa con el valor en inglés, para que
-- getUnifiedHistory (que ya acepta los tres valores vía .in(), pero agrupa/
-- muestra todo bajo el mismo criterio) no las trate como un caso aparte.
UPDATE public.sales
SET status = 'completada'
WHERE status IN ('completed', 'completado');
