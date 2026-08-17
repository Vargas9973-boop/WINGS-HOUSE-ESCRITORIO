-- waste tenía RLS activado (relrowsecurity=true) pero CERO policies, lo que
-- bloquea toda lectura/escritura vía la anon key que usa la app de
-- escritorio (mismo patrón que ya se corrigió en payroll_deductions).
-- Esto rompía en silencio el módulo de Merma (tabla/KPIs siempre vacíos) y
-- el nuevo Historial Unificado, aunque el INSERT vía createWaste/RPC no
-- fallaba visiblemente en algunos flujos.
DROP POLICY IF EXISTS "allow_anon_all" ON public.waste;
CREATE POLICY "allow_anon_all" ON public.waste FOR ALL USING (true) WITH CHECK (true);
