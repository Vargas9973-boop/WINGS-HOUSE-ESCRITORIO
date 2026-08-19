-- KDS (Kitchen Display System): pantalla de cocina en una segunda ventana
-- Electron para la TV de la cocina por HDMI, sin login. No se crea una
-- tabla "orders" aparte: cada comanda/venta ya es una fila de `sales` (mesa,
-- para llevar, mostrador, y también lo que inserta wing-house-web, que no se
-- toca en esta tarea), así que el KDS es solo otra vista de esos mismos
-- datos -- nunca puede desincronizarse con lo que ya muestra Comandas.
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS kds_status text NOT NULL DEFAULT 'nueva',
  ADD COLUMN IF NOT EXISTS kds_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS kds_ready_at timestamptz,
  ADD COLUMN IF NOT EXISTS kds_delivered_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_kds_status_check'
  ) THEN
    ALTER TABLE public.sales
      ADD CONSTRAINT sales_kds_status_check
      CHECK (kds_status IN ('nueva', 'en_preparacion', 'lista', 'entregada'));
  END IF;
END $$;

-- Backfill: sin esto, TODAS las ventas históricas (ya cerradas o canceladas
-- desde mucho antes de que existiera el KDS) se leerían como recién
-- llegadas 'nueva' -- ADD COLUMN ... DEFAULT rellena ese valor por defecto
-- en las filas ya existentes. Solo lo que sigue abierto en este momento
-- (mesas/para llevar en curso) se queda en 'nueva', que es lo correcto: la
-- cocina debe verlo al abrir el KDS por primera vez.
UPDATE public.sales
   SET kds_status = 'entregada',
       kds_delivered_at = COALESCE(kds_delivered_at, now())
 WHERE status IN ('completada', 'cancelada')
   AND kds_status = 'nueva';

-- El KDS siempre filtra kds_status <> 'entregada'; este índice parcial es
-- justo para esa consulta y no crece con el histórico ya entregado.
CREATE INDEX IF NOT EXISTS idx_sales_kds_status_pending
  ON public.sales (created_at)
  WHERE kds_status <> 'entregada';

-- La política "sales_update_anon" (20260815050000_rls_allow_anon_update_sales_printed.sql)
-- ya es FOR UPDATE TO anon USING (true) WITH CHECK (true) -- sin restricción
-- de columnas -- así que estas 4 columnas nuevas ya quedan editables desde
-- el KDS sin política adicional, y "sales_select_anon" ya cubre el SELECT.
