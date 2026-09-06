-- QA de aislamiento entre tenants (2026-09-05), seguimiento a
-- 20260905030000/31000 -- el advisor de seguridad de Supabase
-- (`supabase db advisors --type security`) marcó 4 vistas SECURITY DEFINER
-- que aún no se habían revisado a fondo:
--   - product_inventory_check   (0005_corte_de_caja.sql-era / 20260818020000)
--   - ventas_reales_hoy         (pre multi-tenant)
--   - vista_corte_detallado     (pre multi-tenant)
--   - vista_corte_hoy           (pre multi-tenant)
--
-- Las 4 son de antes de que existiera branch_id/tenant_id como concepto (o,
-- en el caso de product_inventory_check, se documentó desde su creación
-- como "para inspección directa en la base de datos", nunca pensada para
-- consumo de la app) -- ninguna filtra por sucursal, y las 4 tenían
-- `GRANT SELECT ... TO anon, authenticated`. Al ser SECURITY DEFINER,
-- corren con los privilegios del dueño (postgres, bypassa RLS), así que ese
-- GRANT bastaba: cualquiera en internet, SIN sesión, podía hacer
-- `GET /rest/v1/ventas_reales_hoy` y leer, en vivo, folio/monto/mesa/
-- nombre de empleado/método de pago de las ventas de HOY de los 3 tenants
-- mezcladas -- la fuga más grave encontrada en esta auditoría, peor que las
-- de RPC ya corregidas porque no requiere ni siquiera un login.
--
-- vista_corte_hoy y vista_corte_detallado tienen el mismo problema con
-- montos agregados (efectivo/tarjeta/transferencia/total del día), y
-- product_inventory_check con el catálogo completo (nombre de producto +
-- semáforo de stock) de los 3 tenants.
--
-- Confirmado por grep en todo el repo (desktop db.js, wing-house-web,
-- panel_saas): NINGÚN código de la app las consume hoy -- son vistas
-- muertas. El fix correcto no es agregarles un filtro de sucursal (una
-- vista sin parámetros expuesta por PostgREST no puede auto-limitarse al
-- que llama de forma segura -- el cliente podría simplemente omitir el
-- `.eq('branch_id', ...)`), sino cerrarlas del todo, igual que ya se hizo
-- con las tablas via `deny_anon_direct` -- si en el futuro hace falta un
-- reporte multi-tenant real, debe construirse como una RPC SECURITY DEFINER
-- gateada por is_superadmin(), como admin_tenant_activity().
REVOKE SELECT ON public.product_inventory_check FROM anon, authenticated, PUBLIC;
REVOKE SELECT ON public.ventas_reales_hoy FROM anon, authenticated, PUBLIC;
REVOKE SELECT ON public.vista_corte_detallado FROM anon, authenticated, PUBLIC;
REVOKE SELECT ON public.vista_corte_hoy FROM anon, authenticated, PUBLIC;
