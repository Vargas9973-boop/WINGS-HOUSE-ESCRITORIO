-- attendance.employee_id apuntaba por error a accounts(id) (tabla legacy de
-- 1 fila) en vez de employees(id), que es la tabla real que usa la app
-- (getAllEmployees/createEmployee/registerAttendance). Cualquier employee_id
-- real violaba la FK. La tabla está vacía, así que no hay filas que migrar.
ALTER TABLE public.attendance DROP CONSTRAINT IF EXISTS attendance_employee_id_fkey;
ALTER TABLE public.attendance
  ADD CONSTRAINT attendance_employee_id_fkey
  FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;
