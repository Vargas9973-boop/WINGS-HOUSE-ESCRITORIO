-- Fix del bug reportado 2026-08-23 (mismo día, después de
-- 20260823210000_fix_recipes_varchar_text_mismatch.sql): dos ventas de
-- prueba (efectivo y tarjeta) no imprimieron ticket ni aparecieron en KDS.
-- Consola:
--   "No se pudieron ligar las salsas elegidas: structure of query does not
--   match function result type"
--   "Error: No se pudieron obtener los artículos de la venta: structure of
--   query does not match function result type" (getSaleItemsWithModifiers,
--   db.js:1010, vía getSaleById/createSale/getKdsOrders/etc.)
--
-- Causa raíz: mismo patrón que 20260823210000 pero con json/jsonb en vez de
-- varchar/text. get_sale_items_with_modifiers se creó originalmente
-- LANGUAGE sql (20260820025000_close_sale_items_reads.sql) y luego se
-- reescribió LANGUAGE plpgsql con RETURN QUERY en
-- 20260822240000_fase2a_2b_critical_authz.sql (y de nuevo, sin corregirlo,
-- en 20260822260000_fase2ab_revoke_public_default_grant.sql) para agregar el
-- guard de current_visible_branch_ids(). El SELECT interno
-- (to_jsonb(si) || jsonb_build_object(...)) evalúa a jsonb, pero la función
-- declara RETURNS SETOF json. Un SELECT normal castea jsonb->json implícito
-- sin problema, pero RETURN QUERY en PL/pgSQL exige que el tupdesc de la
-- query coincida EXACTO con el tipo declarado -- no aplica el cast de
-- asignación automáticamente (misma causa raíz documentada en
-- 20260823210000, ahí con varchar/text).
--
-- Fix: cast explícito ::json al resultado del SELECT, mismo patrón (cast
-- explícito en vez de cambiar el tipo declarado) que 20260823210000.

CREATE OR REPLACE FUNCTION public.get_sale_items_with_modifiers(p_branch_id bigint, p_sale_ids bigint[])
 RETURNS SETOF json
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (p_branch_id = ANY (COALESCE(public.current_visible_branch_ids(), ARRAY[]::bigint[]))) THEN
    RAISE EXCEPTION 'branch mismatch';
  END IF;

  RETURN QUERY
  SELECT (to_jsonb(si) || jsonb_build_object(
    'sale_item_modifiers',
    COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('id', sim.id, 'modifier_id', sim.modifier_id) ORDER BY sim.id)
         FROM public.sale_item_modifiers sim
        WHERE sim.sale_item_id = si.id),
      '[]'::jsonb
    )
  ))::json
  FROM public.sale_items si
  WHERE si.sale_id = ANY(p_sale_ids)
    AND si.branch_id = p_branch_id
  ORDER BY si.id;
END;
$function$;
