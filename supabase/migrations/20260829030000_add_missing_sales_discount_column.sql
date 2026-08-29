-- Bug reportado en sucursal Xalapeña: al cobrar una mesa (close_table) explota
-- con "column discount of relation sales does not exist". close_table
-- (20260822240000_fase2a_2b_critical_authz.sql) hace
-- UPDATE public.sales SET discount = v_discount ..., y ticket-renderer.js /
-- main.js (export CSV) ya leen sale.discount -- pero ninguna migración
-- rastreada creó jamás esa columna en public.sales. No es un bug de
-- aplicación: falta la columna en la base.
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS discount numeric NOT NULL DEFAULT 0;
