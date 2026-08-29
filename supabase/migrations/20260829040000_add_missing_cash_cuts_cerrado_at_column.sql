-- Auditoría de tenant 2 (La Xalapeña) 2026-08-29: mismo patrón que el bug de
-- sales.discount (20260829030000). close_cash_cut()
-- (20260820040000_rpc_branch_id_cash_and_costs.sql) hace
-- UPDATE/INSERT ... cerrado_at = now() sobre public.cash_cuts, y
-- db.js::getCorteResumen (cerrado/cerradoAt, líneas ~2025-2027) y
-- reports-renderer.js (línea ~203, estado abierto/cerrado del corte) ya leen
-- cash_cuts.cerrado_at -- pero ninguna migración rastreada creó jamás esa
-- columna. Encontrado por barrido estático (scripts/_qa-check-phantom-
-- columns.mjs, no commiteado) comparando cada UPDATE/INSERT de las funciones
-- plpgsql contra information_schema.columns real, no reproducido en vivo
-- contra producción a propósito (cerrar un corte real escribe datos del día
-- de hoy). Sin este fix, CUALQUIER cierre de Corte de Caja (ambos tenants,
-- es una operación diaria) truena con "column cerrado_at of relation
-- cash_cuts does not exist".
ALTER TABLE public.cash_cuts
  ADD COLUMN IF NOT EXISTS cerrado_at timestamptz;
