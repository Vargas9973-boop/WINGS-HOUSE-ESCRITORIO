-- Mismo bug que waste/settings/payroll_deductions: payroll_weeks tenía RLS
-- activado sin ninguna policy. getPayrollWeek()/getPayrollHistory() leen
-- esta tabla directo vía anon key, así que el bono semanal acreditado nunca
-- se releía (la pestaña "Nómina semanal" de Asistencia siempre mostraba
-- "No" aunque ya se hubiera guardado). Ya había 3 filas reales guardadas
-- (probablemente vía set_payroll_bonus, que sí es SECURITY DEFINER).
DROP POLICY IF EXISTS "allow_anon_all" ON public.payroll_weeks;
CREATE POLICY "allow_anon_all" ON public.payroll_weeks FOR ALL USING (true) WITH CHECK (true);
