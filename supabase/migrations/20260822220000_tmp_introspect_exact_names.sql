-- Temporal, parte 3: chequeo exacto (sin ILIKE) de si estas funciones
-- existen hoy en pg_proc bajo el nombre literal que db.js llama.
CREATE OR REPLACE FUNCTION public.tmp_introspect_exact_names()
 RETURNS json
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT json_agg(row_to_json(t)) FROM (
    SELECT x.name, (
      SELECT count(*) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = x.name
    ) AS live_count
    FROM unnest(ARRAY[
      'update_employee','remove_employee','save_fingerprint','clear_fingerprint',
      'update_sale_payment_status','set_cash_cut_fondo_inicial','close_cash_cut',
      'create_cash_movement','remove_cash_movement','comanda_add_item_with_modifiers',
      'comanda_update_delivery_status','set_sale_cashier','set_sale_item_notes_and_modifiers',
      'mark_sale_printed','remove_promotion','create_inventory_item','update_inventory_item',
      'remove_inventory_item','add_inventory_stock','create_cost','remove_cost',
      'create_driver','create_waste_entry'
    ]) AS x(name)
  ) t;
$function$;
GRANT EXECUTE ON FUNCTION public.tmp_introspect_exact_names() TO anon;

CREATE OR REPLACE FUNCTION public.tmp_introspect_total_count()
 RETURNS bigint
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public';
$function$;
GRANT EXECUTE ON FUNCTION public.tmp_introspect_total_count() TO anon;
