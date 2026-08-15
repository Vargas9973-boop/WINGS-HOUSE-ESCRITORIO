-- Habilita eventos de Supabase Realtime (postgres_changes) para public.sales.
--
-- db.js:subscribeToNewSales() se suscribe a INSERT en esta tabla para
-- disparar la alerta sonora de cocina en la app de escritorio cuando llega
-- una comanda desde wings-house-web (o desde otra estación). Sin agregar la
-- tabla a la publicación "supabase_realtime", ningún evento llega al cliente
-- sin importar qué políticas de RLS existan — RLS solo filtra CUÁLES filas
-- se entregan, no si la tabla emite eventos.
--
-- La policy de SELECT para anon que Realtime necesita (RLS también aplica a
-- postgres_changes) ya existe: "sales_select_anon"
-- (20260815050000_rls_allow_anon_update_sales_printed.sql la menciona; no se
-- vuelve a crear aquí para no chocar si ya existe).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'sales'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sales;
  END IF;
END $$;
