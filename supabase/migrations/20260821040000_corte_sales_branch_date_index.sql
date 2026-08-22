-- Auditoría Corte 2026-08-21: a diferencia del índice pedido para KDS (donde
-- ya existía un parcial que cubría exactamente esa consulta y no hacía falta
-- otro), getCorteResumen() SÍ necesita este: filtra sales por
-- branch_id + rango de created_at + status + payment_status, y el único
-- índice existente sobre branch_id (idx_sales_branch_id, de
-- 20260815070000_branch_and_ticket_schema.sql) no incluye created_at -- con
-- meses/años de histórico, cada corte del día tendría que recorrer TODAS las
-- ventas de la sucursal para filtrar la fecha, no solo las del día.
CREATE INDEX IF NOT EXISTS idx_sales_branch_created_payment
  ON public.sales (branch_id, created_at, payment_status);
