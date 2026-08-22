-- TEMPORAL -- no es una migración, es una consulta para correr a mano en el
-- SQL Editor de Supabase (mismo patrón que
-- 20260819060000_tmp_introspect_comanda_set_delivery.sql). Corre esto y
-- pégame el resultado completo (una fila por función, columna "def"): con
-- eso genero la migración 0009-parte-2 agregando p_branch_id a cada una sin
-- adivinar su lógica actual (folios, descuentos de inventario, etc.).
--
-- Funciones que faltan porque no están versionadas en este repo. (Nota:
-- comanda_open_table, comanda_add_item, close_table, comanda_open_takeout,
-- comanda_assign_driver y liquidate_driver_sales SÍ se encontraron en el
-- repo -- ver 20260820020000_rpc_branch_id_core_sales.sql -- y ya no están
-- en esta lista.)
SELECT p.proname, pg_get_functiondef(p.oid) AS def
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'cancel_table',
    'comanda_update_kitchen',
    'register_attendance',
    'create_employee',
    'comanda_board',
    'get_employee_daily_consumption',
    'get_payroll_week_credit',
    'set_payroll_bonus',
    'wh_next_folio'
  )
ORDER BY p.proname;
