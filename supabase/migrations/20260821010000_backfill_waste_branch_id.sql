-- waste.branch_id se agregó manualmente el 2026-08-21 (ALTER TABLE fuera de
-- migraciones versionadas) y quedó NULL en las filas creadas antes de eso.
-- create_waste_entry (20260820050000_rpc_branch_id_hr_and_drivers.sql) ya
-- graba branch_id explícito en filas nuevas; esto solo repara las viejas,
-- infiriendo la sucursal desde inventory.branch_id vía inventory_id.
-- Filas de waste sin inventory_id (item_name libre, sin ligar a inventario)
-- no se pueden inferir así y quedan NULL -- getUnifiedHistory en db.js las
-- deja fuera del historial de otras sucursales pero no rompe la consulta.
UPDATE public.waste w
SET branch_id = i.branch_id
FROM public.inventory i
WHERE w.inventory_id = i.id
  AND w.branch_id IS NULL;
