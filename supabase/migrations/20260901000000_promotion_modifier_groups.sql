-- Extiende el requisito de "elegir salsa(s)" a promociones/paquetes, que
-- hasta ahora solo existía para productos (product_modifier_groups, ver
-- 20260819090000_sauce_modifiers_schema.sql /
-- 20260820000013_catalog_component_recipe_modifier_group_rpcs.sql). Una
-- promoción vive en su propia tabla (promotions), sin relación con
-- products, así que no puede reusar esas filas -- se crea una tabla espejo
-- en vez de tocar product_modifier_groups (esa ya tiene datos reales en
-- prod y un trigger de descuento de inventario detrás; no hace falta
-- arriesgarla para esto).
--
-- Mismo criterio de selección "N salsas distintas, sin cantidades por
-- salsa" que ya usa product_modifier_groups.qty: el cliente elige qty
-- sabores diferentes (p.ej. Búfalo + BBQ para una promo de 20 alitas), sin
-- tener que declarar cuántas piezas de cada uno -- eso lo reparte el
-- cocinero a ojo.
--
-- Cerrada a anon desde el día uno (deny_anon_direct), igual que
-- product_modifier_groups quedó tras 20260820031000: todo acceso pasa por
-- las 2 RPC SECURITY DEFINER de abajo, nunca por SELECT/INSERT directo.

CREATE TABLE IF NOT EXISTS public.promotion_modifier_groups (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  promotion_id bigint NOT NULL REFERENCES public.promotions(id) ON DELETE CASCADE,
  group_name text NOT NULL,
  qty integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (promotion_id, group_name)
);

CREATE INDEX IF NOT EXISTS idx_promotion_modifier_groups_promotion ON public.promotion_modifier_groups (promotion_id);

ALTER TABLE public.promotion_modifier_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "deny_anon_direct" ON public.promotion_modifier_groups;
CREATE POLICY "deny_anon_direct" ON public.promotion_modifier_groups FOR ALL TO anon USING (false) WITH CHECK (false);

-- promotion_modifier_groups no tiene branch_id propio, igual que su espejo
-- de productos -- se acota por JOIN a promotions.branch_id.
CREATE OR REPLACE FUNCTION public.get_promotion_modifier_groups_by_branch(p_branch_id bigint)
RETURNS SETOF public.promotion_modifier_groups
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT pmg.* FROM public.promotion_modifier_groups pmg
  JOIN public.promotions pr ON pr.id = pmg.promotion_id
  WHERE pr.branch_id = p_branch_id;
$$;

CREATE OR REPLACE FUNCTION public.set_promotion_modifier_group(p_branch_id bigint, p_promotion_id bigint, p_group_name text, p_enabled boolean, p_qty integer DEFAULT 1)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.promotions WHERE id = p_promotion_id AND branch_id = p_branch_id) THEN
    RAISE EXCEPTION 'No se encontró la promoción % en esta sucursal', p_promotion_id;
  END IF;

  DELETE FROM public.promotion_modifier_groups WHERE promotion_id = p_promotion_id AND group_name = p_group_name;

  IF p_enabled THEN
    INSERT INTO public.promotion_modifier_groups (promotion_id, group_name, qty)
    VALUES (p_promotion_id, p_group_name, GREATEST(1, COALESCE(p_qty, 1)));
  END IF;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_promotion_modifier_groups_by_branch(bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.set_promotion_modifier_group(bigint, bigint, text, boolean, integer) TO anon;
