-- Auditoría Costos 2026-08-21: de los 3 índices pedidos, 2 ya existen --
-- idx_recipes_insumo (ON recipes(insumo_id), creado en
-- 20260817040000_inventory_movements_recipes.sql) e
-- inventory_name_branch_unique (UNIQUE(name, branch_id), mismo archivo,
-- que ya funciona como índice sobre branch_id+name). Este es el único que
-- de verdad faltaba: computeProfitability() y getAllWaste() filtran waste
-- por branch_id + rango de created_at, y waste no tenía ningún índice más
-- allá de la primary key.
CREATE INDEX IF NOT EXISTS idx_waste_branch_created
  ON public.waste (branch_id, created_at);
