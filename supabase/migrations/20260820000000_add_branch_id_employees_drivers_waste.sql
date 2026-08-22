-- Opción A (RPC + RLS restrictivo, sin Supabase Auth): antes de poder cerrar
-- `anon` en employees/drivers/waste (siguiente migración) esas tablas
-- necesitan su propia columna branch_id -- ninguna la tenía (no estaban en
-- el arreglo de 20260815070000_branch_and_ticket_schema.sql). Sin esto, un
-- roster de empleados o de repartidores es imposible de aislar por
-- sucursal sin importar qué política de RLS se le ponga encima.
--
-- Mismo patrón que esa migración original: se agrega la columna con DEFAULT
-- apuntando a la única sucursal que existe hoy (bootstrap seguro para la
-- instalación en producción), se rellenan las filas existentes y se crea el
-- índice. products/modifiers/recipes/product_components/
-- product_modifier_groups/settings/payroll_* quedan FUERA de esta migración
-- a propósito -- ver nota en el reporte de auditoría (decisión de catálogo
-- compartido vs. por sucursal, todavía pendiente de confirmar).
DO $$
DECLARE
  v_branch_id bigint;
  v_table text;
BEGIN
  SELECT id INTO v_branch_id FROM public.branches ORDER BY id LIMIT 1;

  IF v_branch_id IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna fila en public.branches -- no se puede hacer bootstrap de branch_id.';
  END IF;

  FOREACH v_table IN ARRAY ARRAY['employees', 'drivers', 'waste']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = v_table AND column_name = 'branch_id'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD COLUMN branch_id bigint REFERENCES public.branches(id) DEFAULT %s',
        v_table, v_branch_id
      );
    ELSE
      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN branch_id SET DEFAULT %s',
        v_table, v_branch_id
      );
    END IF;

    EXECUTE format('UPDATE public.%I SET branch_id = %s WHERE branch_id IS NULL', v_table, v_branch_id);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_branch_id ON public.%I (branch_id)', v_table, v_table);
  END LOOP;
END $$;
