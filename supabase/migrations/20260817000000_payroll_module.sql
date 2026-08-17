-- Módulo de Nómina configurable: día de pago ajustable + tabla de
-- deducciones por crédito de empleado (ya existía payroll_deductions vacía,
-- provisionada para esto, sin week_start/week_end) + snapshot histórico al
-- cerrar la nómina de una semana.

ALTER TABLE public.payroll_deductions
ADD COLUMN IF NOT EXISTS week_start date;

ALTER TABLE public.payroll_deductions
ADD COLUMN IF NOT EXISTS week_end date;

-- payroll_deductions ya tenía RLS activado pero sin ninguna policy (quedó
-- inaccesible desde el cliente anon), consistente con que nunca se usó.
DROP POLICY IF EXISTS "allow_anon_all" ON public.payroll_deductions;
CREATE POLICY "allow_anon_all" ON public.payroll_deductions FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.payroll_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  week_start date NOT NULL,
  week_end date NOT NULL,
  employee_id bigint,
  employee_name text NOT NULL,
  sueldo_base numeric(10,2) NOT NULL DEFAULT 0,
  creditos numeric(10,2) NOT NULL DEFAULT 0,
  faltas int NOT NULL DEFAULT 0,
  deduccion_faltas numeric(10,2) NOT NULL DEFAULT 0,
  beneficio_usado numeric(10,2) NOT NULL DEFAULT 0,
  total_pagado numeric(10,2) NOT NULL DEFAULT 0,
  cerrado_por text,
  cerrado_at timestamptz DEFAULT now(),
  UNIQUE(week_start, employee_id)
);

ALTER TABLE public.payroll_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_anon_all" ON public.payroll_history;
CREATE POLICY "allow_anon_all" ON public.payroll_history FOR ALL USING (true) WITH CHECK (true);
