-- Habilita eventos de Supabase Realtime (postgres_changes) para
-- public.products y public.inventory.
--
-- db.js:subscribeToCatalogChanges() se suscribe a INSERT/UPDATE/DELETE en
-- estas dos tablas para que catálogo, inventario, POS y comandas se
-- refresquen solos en cualquier instalación cuando se agrega/edita un
-- producto o un insumo -- sin esto, ningún evento llega al cliente sin
-- importar qué políticas de RLS existan (RLS solo filtra CUÁLES filas se
-- entregan, no si la tabla emite eventos).
--
-- Las policies de SELECT para authenticated que Realtime necesita (RLS
-- también aplica a postgres_changes) ya existen:
-- "products_select_own_branch" e "inventory_select_own_branch"
-- (20260822120000_rls_restrictive_phase1.sql) -- no se vuelven a crear aquí.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'products'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.products;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'inventory'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.inventory;
  END IF;
END $$;
