-- settings tenía RLS activado (relrowsecurity=true) pero CERO policies:
-- set_setting() es SECURITY DEFINER así que las escrituras "funcionaban",
-- pero getAllSettings()/getSetting() leen la tabla directo vía anon key y
-- siempre devolvían vacío. Efecto real: nombre/dirección/teléfono del
-- negocio en tickets, % descuento empleado, impresora guardada, ancho de
-- ticket y el nuevo payroll_payday nunca se releían -- todo caía siempre a
-- los defaults hardcodeados en cada renderer, aparentando funcionar.
DROP POLICY IF EXISTS "allow_anon_all" ON public.settings;
CREATE POLICY "allow_anon_all" ON public.settings FOR ALL USING (true) WITH CHECK (true);
