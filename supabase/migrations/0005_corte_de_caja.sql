-- FIX CORTE DE CAJA - Corre este

-- 1. Borra vistas que estorban (el error que te sale)
DROP VIEW IF EXISTS public.vista_corte_hoy CASCADE;
DROP VIEW IF EXISTS public.vista_corte CASCADE;

-- 2. cash_cuts
CREATE TABLE IF NOT EXISTS public.cash_cuts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fecha date NOT NULL,
  branch_id bigint NOT NULL DEFAULT 1,
  fondo_inicial numeric(10,2) NOT NULL DEFAULT 0,
  efectivo_real numeric(10,2),
  cerrado_por text,
  notas text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(fecha, branch_id)
);

-- 3. cash_movements - si ya existe, solo agregamos columnas faltantes
CREATE TABLE IF NOT EXISTS public.cash_movements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fecha date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Mexico_City')::date,
  concepto text NOT NULL,
  monto numeric NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.cash_movements 
ADD COLUMN IF NOT EXISTS metodo_pago text DEFAULT 'efectivo' CHECK (metodo_pago IN ('efectivo','tarjeta','transferencia'));

ALTER TABLE public.cash_movements 
ADD COLUMN IF NOT EXISTS categoria_costo text DEFAULT 'repartidores';

-- 4. costs - agrega metodo_pago para reflejar salidas
ALTER TABLE public.costs 
ADD COLUMN IF NOT EXISTS metodo_pago text DEFAULT 'efectivo';

-- 5. Vista nueva (simple, sin conflicto)
CREATE OR REPLACE VIEW public.vista_corte_hoy AS
SELECT
  (now() AT TIME ZONE 'America/Mexico_City')::date as fecha,
  SUM(s.total - COALESCE(s.delivery_fee,0)) FILTER (WHERE s.status='completada') as venta_comida,
  SUM(COALESCE(s.delivery_fee,0)) FILTER (WHERE s.status='completada') as venta_envios,
  SUM(s.total) FILTER (WHERE s.status='completada') as total_ventas,
  SUM(s.total) FILTER (WHERE s.status='completada' AND s.payment_method='efectivo') as venta_efectivo,
  SUM(s.total) FILTER (WHERE s.status='completada' AND s.payment_method='tarjeta') as venta_tarjeta,
  SUM(s.total) FILTER (WHERE s.status='completada' AND s.payment_method='transferencia') as venta_transferencia
FROM public.sales s
WHERE date(s.created_at AT TIME ZONE 'America/Mexico_City') = (now() AT TIME ZONE 'America/Mexico_City')::date;

-- 6. Permisos
ALTER TABLE public.cash_cuts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_anon_all" ON public.cash_cuts;
DROP POLICY IF EXISTS "allow_anon_all" ON public.cash_movements;
CREATE POLICY "allow_anon_all" ON public.cash_cuts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_anon_all" ON public.cash_movements FOR ALL USING (true) WITH CHECK (true);