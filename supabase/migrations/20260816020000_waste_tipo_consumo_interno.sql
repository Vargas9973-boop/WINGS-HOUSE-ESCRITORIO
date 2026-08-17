-- Distingue merma real de consumo interno (jefes) dentro de la misma tabla
-- "waste", para poder filtrar y sumar el consumo interno del mes en Reportes
-- sin crear una tabla nueva.

ALTER TABLE public.waste
ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'merma' CHECK (tipo IN ('merma', 'consumo_interno'));

ALTER TABLE public.waste
ADD COLUMN IF NOT EXISTS autorizado_por text;
