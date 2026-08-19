-- Utilidad de conversión de unidades (masa/volumen), pedida como pieza
-- opcional de infraestructura para cuando la receta de un producto necesite
-- compararse contra un insumo llevado en una unidad distinta (hoy
-- catalog-renderer.js siempre guarda quantity_needed en la unidad propia
-- del insumo, así que nada la usa todavía -- ver el espejo en JS,
-- convertUnit() en common.js).
--
-- NO se toca ningún trigger existente (sale_items_check_recipe_stock /
-- sale_items_apply_recipe_inventory siguen asumiendo receta e inventario en
-- la misma unidad, que es como se guardan hoy).
--
-- Regresa NULL cuando las unidades no son convertibles entre sí (unidades de
-- conteo como pz/orden/porción, o mezclar masa con volumen) -- el llamador
-- debe bloquear con un mensaje explícito en vez de asumir una conversión.
CREATE TABLE IF NOT EXISTS public.unit_conversions (
  from_unit text NOT NULL,
  to_unit text NOT NULL,
  factor numeric NOT NULL,
  PRIMARY KEY (from_unit, to_unit)
);

ALTER TABLE public.unit_conversions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_anon_select" ON public.unit_conversions;
CREATE POLICY "allow_anon_select" ON public.unit_conversions FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.unit_conversions TO anon, authenticated;

INSERT INTO public.unit_conversions (from_unit, to_unit, factor) VALUES
  ('kg', 'g', 1000),
  ('kg', 'mg', 1000000),
  ('g', 'kg', 0.001),
  ('g', 'mg', 1000),
  ('mg', 'g', 0.001),
  ('mg', 'kg', 0.000001),
  ('L', 'ml', 1000),
  ('ml', 'L', 0.001)
ON CONFLICT (from_unit, to_unit) DO UPDATE SET factor = EXCLUDED.factor;

CREATE OR REPLACE FUNCTION public.convert_unit(p_qty numeric, p_from text, p_to text)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_factor numeric;
BEGIN
  IF p_from = p_to THEN
    RETURN p_qty;
  END IF;

  SELECT factor INTO v_factor
    FROM public.unit_conversions
   WHERE from_unit = p_from AND to_unit = p_to;

  IF v_factor IS NULL THEN
    RETURN NULL; -- unidades no convertibles -- el llamador debe bloquear
  END IF;

  RETURN p_qty * v_factor;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.convert_unit(numeric, text, text) TO anon, authenticated;
