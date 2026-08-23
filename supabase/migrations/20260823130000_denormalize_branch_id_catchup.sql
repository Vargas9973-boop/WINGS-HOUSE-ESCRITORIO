-- Auditoría de ventas 2026-08-23: 20260820000014_denormalize_branch_id.sql
-- quedó comiteada incompleta -- el archivo corta a media línea justo después
-- del header ("-- 1. sale_items -- columna + backfill + trigger"), sin
-- ningún ALTER TABLE/CREATE TRIGGER real, pese a que su propio mensaje de
-- commit decía "Migracion 00014 completa". Verificado en vivo (proyecto
-- acvsmyvijzqredqmoxti vía `supabase db query --linked`) que sale_items y
-- sale_item_modifiers SÍ tienen branch_id (bigint, FK a branches, 0 filas
-- NULL) con triggers BEFORE INSERT (sale_items_set_branch_id/
-- sale_item_modifiers_set_branch_id) que lo derivan del padre -- exactamente
-- el diseño que el archivo 000014 planeaba pero nunca llegó a escribir. Las
-- policies RLS que ya dependen de esta columna (sale_items_select_own_branch,
-- sale_item_modifiers_select_own_branch, ambas con
-- current_visible_branch_ids()) también están vigentes y no se tocan aquí.
--
-- Esto es un caso real de drift: el cambio se aplicó a producción (probable
-- SQL editor del dashboard, no vía `db push`) sin dejar rastro reproducible
-- en el repo. Esta migración reconstruye exactamente ese estado con DDL
-- idempotente -- en la base viva no debe cambiar una sola fila (0 backfills,
-- funciones/triggers ya idénticos), y en un ambiente nuevo (`supabase db
-- reset` / staging) deja de faltar esta pieza silenciosamente.

ALTER TABLE public.sale_items
  ADD COLUMN IF NOT EXISTS branch_id bigint REFERENCES public.branches(id);

ALTER TABLE public.sale_item_modifiers
  ADD COLUMN IF NOT EXISTS branch_id bigint REFERENCES public.branches(id);

UPDATE public.sale_items si
SET branch_id = s.branch_id
FROM public.sales s
WHERE si.sale_id = s.id
  AND si.branch_id IS NULL;

UPDATE public.sale_item_modifiers sim
SET branch_id = si.branch_id
FROM public.sale_items si
WHERE sim.sale_item_id = si.id
  AND sim.branch_id IS NULL;

CREATE OR REPLACE FUNCTION public.sale_items_set_branch_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.branch_id IS NULL THEN
    SELECT branch_id INTO NEW.branch_id FROM public.sales WHERE id = NEW.sale_id;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sale_item_modifiers_set_branch_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.branch_id IS NULL THEN
    SELECT branch_id INTO NEW.branch_id FROM public.sale_items WHERE id = NEW.sale_item_id;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sale_items_set_branch_id ON public.sale_items;
CREATE TRIGGER trg_sale_items_set_branch_id
  BEFORE INSERT ON public.sale_items
  FOR EACH ROW EXECUTE FUNCTION public.sale_items_set_branch_id();

DROP TRIGGER IF EXISTS trg_sale_item_modifiers_set_branch_id ON public.sale_item_modifiers;
CREATE TRIGGER trg_sale_item_modifiers_set_branch_id
  BEFORE INSERT ON public.sale_item_modifiers
  FOR EACH ROW EXECUTE FUNCTION public.sale_item_modifiers_set_branch_id();
