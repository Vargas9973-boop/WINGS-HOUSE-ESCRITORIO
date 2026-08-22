-- Auditoría Asistencia 2026-08-21: attendance no tenía índice compuesto --
-- getTodayAttendance/getAllAttendance/getPayrollData/getPayrollDetail
-- filtran por branch_id + rango de timestamp, y solo existía el índice
-- genérico de branch_id solo (idx_attendance_branch_id, de
-- 20260815070000_branch_and_ticket_schema.sql).
CREATE INDEX IF NOT EXISTS idx_attendance_branch_timestamp
  ON public.attendance (branch_id, timestamp);
