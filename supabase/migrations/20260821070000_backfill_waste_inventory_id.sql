-- Auditoría Waste 2026-08-21: revisé waste-renderer.js/db.js::createWaste
-- a fondo y el flujo REAL ya está bien -- no es un bug vigente. El modal de
-- merma/consumo interno ya tiene un <select id="waste-inventory"> poblado
-- con window.db.inventory.getAll() (branch-scoped) y el guardado exige
-- seleccionar un insumo real (`if (!inventoryId || !quantity)`) antes de
-- llamar a window.db.waste.create({inventory_id: inventoryId, ...}) -- no
-- existe ninguna vía de captura por nombre libre. Los 3 registros con
-- inventory_id NULL que el usuario reportó son datos históricos de antes de
-- que este selector existiera (o una carga manual), no algo que el código
-- actual siga produciendo.
-- Esto solo repara esos registros viejos: intenta emparejar por nombre
-- (case-insensitive) dentro de la misma sucursal. Si no encuentra match no
-- toca la fila (se queda en NULL, no se inventa un insumo) -- ya tiene
-- branch_id correcto desde 20260821010000_backfill_waste_branch_id.sql.
UPDATE public.waste w
SET inventory_id = i.id
FROM public.inventory i
WHERE w.inventory_id IS NULL
  AND w.branch_id = i.branch_id
  AND LOWER(TRIM(w.item_name)) = LOWER(TRIM(i.name));
