-- Completa la dependencia CATALOGO -> INVENTARIO: hasta ahora
-- trg_sale_items_apply_recipe_inventory (20260817040000) descontaba el
-- insumo de la receta en cada venta, pero con GREATEST(...,0) nunca
-- bloqueaba: una venta con insumo agotado se cobraba igual y el stock se
-- quedaba en 0. Esta migración agrega el bloqueo real:
--   1) Un trigger BEFORE en sale_items que revisa, antes de permitir la
--      fila, si hay insumo suficiente para la receta completa del
--      producto -- y aborta la operación (RAISE EXCEPTION, hace ROLLBACK
--      de la transacción completa de process_sale/comanda_add_item/
--      comanda_update_item_qty) si no la hay.
--   2) Bloqueo de fila (FOR UPDATE) sobre el insumo mientras se revisa,
--      para que dos ventas simultáneas del mismo insumo no puedan pasar
--      ambas la validación con el mismo stock (carrera clásica): la
--      segunda transacción espera a que la primera termine (commit o
--      rollback) y vuelve a leer el stock ya actualizado.
--   3) Una vista de solo lectura product_inventory_check con el semáforo
--      (sin_receta/rojo/amarillo/verde) por producto, para inspección
--      directa en la base de datos -- la app calcula lo mismo del lado
--      del cliente (catalog/sales/comandas-renderer.js) para no depender
--      de un viaje extra al servidor por cada render.
-- Solo se valida cuando la operación CONSUME más insumo (delta positivo);
-- quitar un artículo o bajar su cantidad siempre se permite, igual que ya
-- hace el trigger de descuento existente.

CREATE OR REPLACE FUNCTION public.sale_items_check_recipe_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_delta numeric;
  v_ref_id bigint;
  v_item_type text;
  v_rec record;
  v_product_name text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_delta := NEW.quantity;
    v_ref_id := NEW.ref_id;
    v_item_type := COALESCE(NEW.item_type, 'product');
  ELSE -- UPDATE
    v_ref_id := NEW.ref_id;
    v_item_type := COALESCE(NEW.item_type, 'product');
    IF COALESCE(NEW.ref_id, -1) IS DISTINCT FROM COALESCE(OLD.ref_id, -1)
       OR COALESCE(NEW.item_type, 'product') IS DISTINCT FROM COALESCE(OLD.item_type, 'product')
    THEN
      -- Cambió el artículo: se exige stock para la cantidad nueva completa
      -- (la reposición del artículo viejo la hace el trigger AFTER, después).
      v_delta := NEW.quantity;
    ELSE
      v_delta := NEW.quantity - OLD.quantity;
    END IF;
  END IF;

  IF v_item_type = 'product' AND v_ref_id IS NOT NULL AND v_delta > 0 THEN
    FOR v_rec IN
      SELECT r.quantity_needed, i.name, i.unit, i.stock
      FROM public.recipes r
      JOIN public.inventory i ON i.id = r.insumo_id
      WHERE r.product_id = v_ref_id
      ORDER BY i.id
      FOR UPDATE OF i
    LOOP
      IF v_rec.stock < v_rec.quantity_needed * v_delta THEN
        SELECT name INTO v_product_name FROM public.products WHERE id = v_ref_id;
        RAISE EXCEPTION 'Sin stock suficiente de "%" (% % disponibles) para preparar "%". Se actualizó el inventario, abastece antes de vender.',
          v_rec.name, v_rec.stock, COALESCE(v_rec.unit, ''), COALESCE(v_product_name, 'este producto')
          USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sale_items_check_recipe_stock ON public.sale_items;
CREATE TRIGGER trg_sale_items_check_recipe_stock
BEFORE INSERT OR UPDATE ON public.sale_items
FOR EACH ROW EXECUTE FUNCTION public.sale_items_check_recipe_stock();

-- ==========================================================================
-- VISTA: semáforo de disponibilidad por producto
-- ==========================================================================
-- sin_receta: el producto no tiene receta configurada todavía (no se
--             bloquea -- flujo legacy, ver catalog-renderer.js).
-- rojo:       al menos un insumo de la receta no alcanza para 1 venta.
-- amarillo:   toda la receta alcanza, pero algún insumo ya está en su
--             mínimo o por debajo.
-- verde:      receta completa con stock por encima del mínimo.
CREATE OR REPLACE VIEW public.product_inventory_check AS
SELECT
  p.id AS product_id,
  p.name AS product_name,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM public.recipes r WHERE r.product_id = p.id) THEN 'sin_receta'
    WHEN EXISTS (
      SELECT 1 FROM public.recipes r JOIN public.inventory i ON i.id = r.insumo_id
      WHERE r.product_id = p.id AND i.stock < r.quantity_needed
    ) THEN 'rojo'
    WHEN EXISTS (
      SELECT 1 FROM public.recipes r JOIN public.inventory i ON i.id = r.insumo_id
      WHERE r.product_id = p.id AND i.stock <= i.min_stock
    ) THEN 'amarillo'
    ELSE 'verde'
  END AS status
FROM public.products p;

GRANT SELECT ON public.product_inventory_check TO anon, authenticated;
