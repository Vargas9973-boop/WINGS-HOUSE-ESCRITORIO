-- Seguimiento inmediato a 20260905030000: el REVOKE ... FROM anon de esa
-- migración no cerró el hueco -- proacl mostraba que ambas funciones también
-- tenían EXECUTE otorgado a PUBLIC desde su creación original en
-- 20260901000000 (CREATE OR REPLACE FUNCTION preserva el ACL existente, no
-- lo resetea), y `anon` hereda cualquier privilegio de PUBLIC sin importar
-- un REVOKE dirigido solo a `anon`. Verificado en vivo tras el push: ambas
-- seguían con anon_can_exec=true. Su hermana de productos
-- (get_product_modifier_groups_by_branch) nunca tuvo el grant a PUBLIC, por
-- eso no tuvo este problema.
REVOKE EXECUTE ON FUNCTION public.get_promotion_modifier_groups_by_branch(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_promotion_modifier_group(bigint, bigint, text, boolean, integer) FROM PUBLIC;
