-- Limpieza de datos de verificación (cajero_test / Empleado Cliente Test /
-- ventas de prueba 73 y 74) y de las funciones temporales de introspección
-- creadas para planear esta migración. Corre con la conexión directa de la
-- CLI (mismo nivel de privilegio que service_role), ya que anon no tiene
-- permiso de DELETE sobre sales por diseño.
DELETE FROM public.employee_consumption WHERE employee_id IN (
  SELECT id FROM public.employees WHERE name = 'Empleado Cliente Test'
);
DELETE FROM public.employee_weekly_credit WHERE employee_id IN (
  SELECT id FROM public.employees WHERE name = 'Empleado Cliente Test'
);
DELETE FROM public.sale_items WHERE sale_id IN (
  SELECT id FROM public.sales WHERE opened_by = 'cajero_test'
);
DELETE FROM public.sales WHERE opened_by = 'cajero_test';
DELETE FROM public.employees WHERE name = 'Empleado Cliente Test';
DELETE FROM public.users WHERE username = 'cajero_test';

DROP FUNCTION IF EXISTS public.tmp_schema_introspect();
DROP FUNCTION IF EXISTS public.tmp_func_defs();
