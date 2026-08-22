-- Punto 2 (cerrar RPC caja negra), hallazgo NO esperado: al introspeccionar
-- pg_proc completo (pedido al usuario para no dejar nada suelto) aparecieron
-- 5 funciones con DOS firmas vivas al mismo tiempo -- la vieja (previa a
-- alguna de las migraciones de branch_id/seguridad de esta semana) y la
-- nueva, coexistiendo. CREATE OR REPLACE FUNCTION solo reemplaza in-place
-- cuando la lista de tipos de parámetros es IDÉNTICA; agregar un parámetro
-- nuevo (aunque sea con DEFAULT) cambia esa lista, así que Postgres crea
-- una sobrecarga nueva en vez de reemplazar -- exactamente el mismo error
-- que ya se documentó (y sí se evitó bien) en
-- 20260820020000_rpc_branch_id_core_sales.sql para process_sale/
-- comanda_update_item_qty/comanda_remove_item/comanda_set_delivery, pero
-- que NO se repitió para estas 5 en migraciones posteriores de esta misma
-- semana:
--   - close_table(bigint,numeric,text,numeric,text) -- SIN p_branch_id,
--     coexistiendo con la versión corregida en
--     20260821050000_close_table_payment_required.sql. Llamable así se
--     salta la validación de sucursal Y la exigencia de método de pago.
--   - process_sale(numeric,bigint,text,numeric,numeric,bigint,text,jsonb,text,text)
--     -- version vieja de 10 parámetros (sin p_is_delivery ni los 4 nuevos
--     de beneficio/crédito), coexistiendo con la de 15 parámetros de
--     20260822040000. Verificado: ni db.js ni wing-house-web la llaman
--     (ambos mandan p_is_delivery, que esta vieja ni siquiera tiene, así
--     que PostgREST nunca pudo resolverla para esas llamadas) -- segura de
--     borrar.
--   - update_kds_status(bigint,integer,text) -- p_sale_id integer, vieja,
--     coexistiendo con la de p_sale_id bigint
--     (20260821030000_kds_status_transition_guard.sql). Estas dos firmas
--     comparten los MISMOS nombres de parámetro (solo cambia el tipo de
--     uno), lo que puede volver ambigua la resolución de PostgREST para
--     cualquier llamada -- no solo un hueco de seguridad, un riesgo real
--     de que la función deje de poder llamarse.
--   - create_product(bigint,text,text,numeric,numeric,boolean,integer,numeric)
--     y update_product(bigint,bigint,text,text,numeric,numeric,boolean,integer,numeric)
--     -- versiones sin p_cost_per_unit, coexistiendo con las de
--     20260821090000_product_cost_and_cogs_support.sql. db.js ya manda
--     p_cost_per_unit siempre, así que nunca resuelve a estas -- seguras
--     de borrar.
-- Ninguna se reescribe: se DROPean las firmas viejas, dejando solo la ya
-- corregida de cada una.
DROP FUNCTION IF EXISTS public.close_table(bigint, numeric, text, numeric, text);
DROP FUNCTION IF EXISTS public.process_sale(numeric, bigint, text, numeric, numeric, bigint, text, jsonb, text, text);
DROP FUNCTION IF EXISTS public.update_kds_status(bigint, integer, text);
DROP FUNCTION IF EXISTS public.create_product(bigint, text, text, numeric, numeric, boolean, integer, numeric);
DROP FUNCTION IF EXISTS public.update_product(bigint, bigint, text, text, numeric, numeric, boolean, integer, numeric);
