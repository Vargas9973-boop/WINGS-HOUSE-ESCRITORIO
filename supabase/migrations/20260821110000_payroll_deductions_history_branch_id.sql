-- Auditoría Nómina 2026-08-21: payroll_deductions y payroll_history nunca
-- recibieron branch_id en el rollout original (20260815070000_branch_and_ticket_schema.sql
-- solo cubrió users/sales/inventory/costs/attendance/promotions/folio_counters).
-- closePayrollWeek (db.js) marcaba 'descontado' TODAS las deducciones
-- pendientes en el rango de fechas sin filtrar sucursal -- cerrar la
-- nómina de una sucursal habría liquidado también las deducciones de
-- cualquier otra sucursal que compartiera esas fechas. Igual de real para
-- getPayrollDetail, que leía payroll_deductions solo por employee_name
-- (no garantizado único entre sucursales).
ALTER TABLE public.payroll_deductions
  ADD COLUMN IF NOT EXISTS branch_id bigint REFERENCES public.branches(id);

ALTER TABLE public.payroll_history
  ADD COLUMN IF NOT EXISTS branch_id bigint REFERENCES public.branches(id);

-- Backfill de filas existentes: payroll_deductions casi siempre tiene
-- sale_id (se inserta desde createSale justo después de process_sale), así
-- que se infiere la sucursal de la venta; payroll_history no tiene FK a
-- sales pero sí employee_id, se infiere de employees. Lo que no se pueda
-- inferir (sale_id/employee_id NULL) cae en la única sucursal real hoy.
UPDATE public.payroll_deductions pd
SET branch_id = s.branch_id
FROM public.sales s
WHERE pd.sale_id = s.id
  AND pd.branch_id IS NULL;

UPDATE public.payroll_history ph
SET branch_id = e.branch_id
FROM public.employees e
WHERE ph.employee_id = e.id
  AND ph.branch_id IS NULL;

UPDATE public.payroll_deductions SET branch_id = 1 WHERE branch_id IS NULL;
UPDATE public.payroll_history SET branch_id = 1 WHERE branch_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_deductions_branch_status_created
  ON public.payroll_deductions (branch_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_payroll_history_branch_week
  ON public.payroll_history (branch_id, week_start);
