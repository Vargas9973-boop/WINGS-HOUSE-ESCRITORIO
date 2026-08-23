-- Auditoría de Comandas/Corte 2026-08-23: 2 hallazgos reales, uno crítico sin
-- necesitar sesión, otro crítico cross-tenant con sesión autenticada.
--
-- 1) drivers: la tabla se quedó fuera de las 21 que ya se cerraron
--    (products/modifiers/payroll_*/sale_items/etc.) -- sigue con su policy
--    original `allow_anon_all FOR ALL TO public USING(true) WITH CHECK(true)`
--    (confirmado en pg_policies). Cualquiera con la anon key pública, SIN
--    login, puede leer/escribir/borrar cualquier repartidor (nombre,
--    teléfono) de cualquier sucursal o tenant. db.js::getDrivers() ya filtra
--    por branch_id del lado del cliente y createDriver() ya usa la RPC
--    create_driver (con guard correcto) -- no hay ningún .from('drivers')
--    de escritura en todo el repo, así que cerrar la policy no rompe nada.
--    Mismo patrón exacto que sales/payroll_deductions (SELECT propio-tenant
--    para authenticated vía current_visible_branch_ids(), sin policy para
--    anon -- RLS deniega todo lo demás por defecto).
--
-- 2) comanda_remove_item / comanda_update_item_qty: a diferencia de TODAS
--    sus RPCs hermanas (comanda_add_item, close_table, cancel_table,
--    comanda_open_table, etc.), nunca comparan p_branch_id contra
--    current_branch_id() -- solo lo usan para acotar el JOIN que localiza la
--    fila (`s.branch_id = p_branch_id`). Un usuario autenticado de CUALQUIER
--    tenant puede pasar el p_branch_id de otro negocio + un p_item_id real
--    de una comanda abierta ahí y borrar/modificar esa línea directamente --
--    sabotaje cross-tenant sobre sale_items compartido con Ventas. Fix:
--    mismo guard que ya usan todas sus hermanas.

-- Hallazgo adicional al aplicar esto: drivers NUNCA tuvo columna branch_id
-- en producción (información_schema confirmado en vivo -- solo id/name/
-- phone/active/created_at), pese a que 20260820000000_add_branch_id_
-- employees_drivers_waste.sql dice haberla agregado (employees/waste sí la
-- tienen, drivers no) y a que create_driver/comanda_assign_driver YA
-- estaban escritas asumiendo que existe (`INSERT INTO drivers (name,
-- phone, branch_id)...`, `WHERE ... AND branch_id = p_branch_id`) -- ambas
-- RPCs fallarían con 42703 en cuanto alguien intentara usarlas de verdad
-- (plpgsql no valida las columnas de un INSERT/SELECT estático hasta la
-- primera ejecución, así que `CREATE FUNCTION` no lo detectó). Mismo tipo
-- de drift ya visto en sale_items (ver 20260823130000) -- aquí además es
-- una función rota en producción, no solo un hueco de aislamiento. Se
-- agrega la columna con el mismo bootstrap seguro que usó 000000 para
-- employees/waste (branch_id de la primera sucursal existente) antes de
-- poder cerrar la policy.
DO $$
DECLARE
  v_branch_id bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'drivers' AND column_name = 'branch_id'
  ) THEN
    SELECT id INTO v_branch_id FROM public.branches ORDER BY id LIMIT 1;
    IF v_branch_id IS NULL THEN
      RAISE EXCEPTION 'No hay ninguna fila en public.branches -- no se puede hacer bootstrap de branch_id.';
    END IF;

    ALTER TABLE public.drivers ADD COLUMN branch_id bigint REFERENCES public.branches(id);
    UPDATE public.drivers SET branch_id = v_branch_id WHERE branch_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_drivers_branch_id ON public.drivers (branch_id);
  END IF;
END $$;

DROP POLICY IF EXISTS allow_anon_all ON public.drivers;

ALTER TABLE public.drivers ENABLE ROW LEVEL SECURITY;

CREATE POLICY drivers_select_own_branch ON public.drivers
  FOR SELECT TO authenticated
  USING (branch_id = ANY (current_visible_branch_ids()));

CREATE OR REPLACE FUNCTION public.comanda_remove_item(p_branch_id bigint, p_item_id bigint)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_sale_id bigint;
    v_sale json;
BEGIN
    IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
        RAISE EXCEPTION 'branch mismatch';
    END IF;

    SELECT si.sale_id
    INTO v_sale_id
    FROM public.sale_items si
    JOIN public.sales s ON s.id = si.sale_id
    WHERE si.id = p_item_id AND s.branch_id = p_branch_id
    LIMIT 1;

    IF v_sale_id IS NULL THEN
        RAISE EXCEPTION 'No se encontró el artículo de la comanda en esta sucursal.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.sales WHERE id = v_sale_id AND status = 'abierta'
    ) THEN
        RAISE EXCEPTION 'La mesa ya no está abierta.';
    END IF;

    DELETE FROM public.sale_items WHERE id = p_item_id;

    UPDATE public.sales
    SET total = COALESCE(
        (SELECT SUM(si.subtotal) FROM public.sale_items si WHERE si.sale_id = v_sale_id),
        0
    )
    WHERE id = v_sale_id AND status = 'abierta';

    SELECT row_to_json(s) INTO v_sale FROM public.sales s WHERE s.id = v_sale_id LIMIT 1;
    IF v_sale IS NULL THEN
        RAISE EXCEPTION 'No se pudo recuperar la mesa después de eliminar el artículo.';
    END IF;
    RETURN v_sale;
END;
$function$;

CREATE OR REPLACE FUNCTION public.comanda_update_item_qty(p_branch_id bigint, p_item_id bigint, p_quantity integer)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_sale_id bigint;
    v_sale json;
BEGIN
    IF p_branch_id IS DISTINCT FROM public.current_branch_id() THEN
        RAISE EXCEPTION 'branch mismatch';
    END IF;

    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        RAISE EXCEPTION 'La cantidad debe ser mayor que cero.';
    END IF;

    SELECT si.sale_id
    INTO v_sale_id
    FROM public.sale_items si
    JOIN public.sales s ON s.id = si.sale_id
    WHERE si.id = p_item_id AND s.branch_id = p_branch_id
    LIMIT 1;

    IF v_sale_id IS NULL THEN
        RAISE EXCEPTION 'No se encontró el artículo de la comanda en esta sucursal.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.sales WHERE id = v_sale_id AND status = 'abierta'
    ) THEN
        RAISE EXCEPTION 'La mesa ya no está abierta.';
    END IF;

    UPDATE public.sale_items
    SET quantity = p_quantity,
        subtotal = COALESCE(unit_price, 0) * p_quantity
    WHERE id = p_item_id;

    UPDATE public.sales
    SET total = COALESCE(
        (SELECT SUM(si.subtotal) FROM public.sale_items si WHERE si.sale_id = v_sale_id),
        0
    )
    WHERE id = v_sale_id AND status = 'abierta';

    SELECT row_to_json(s) INTO v_sale FROM public.sales s WHERE s.id = v_sale_id LIMIT 1;
    IF v_sale IS NULL THEN
        RAISE EXCEPTION 'No se pudo recuperar la mesa actualizada.';
    END IF;
    RETURN v_sale;
END;
$function$;

-- wh_next_folio() de 0 argumentos: huérfana (cero llamadores reales -- ver
-- 20260822070000_folio_counters_branch_scoped.sql, close_table/process_sale
-- ya usan la versión con p_branch_id), pero sigue GRANTeada a authenticated.
-- No es fuga de datos, pero es superficie innecesaria callable por REST.
REVOKE EXECUTE ON FUNCTION public.wh_next_folio() FROM authenticated, anon;
DROP FUNCTION IF EXISTS public.wh_next_folio();
