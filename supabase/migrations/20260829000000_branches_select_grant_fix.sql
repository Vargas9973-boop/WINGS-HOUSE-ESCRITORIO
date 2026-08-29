-- Fix: 20260822120000_rls_restrictive_phase1.sql activó RLS en `branches` y
-- creó branches_select_all (FOR SELECT TO anon, authenticated USING (true)),
-- pero nunca agregó el GRANT de nivel de tabla que esa policy necesita para
-- surtir efecto. Sin el GRANT, Postgres corta antes de evaluar la policy y
-- PostgREST devuelve "permission denied for table branches" -- no un bloqueo
-- de RLS (que hubiera devuelto 0 filas), sino ausencia total del privilegio
-- base. Esto rompe getAllBranches() (db.js) en el único momento en que corre
-- sin sesión: el arranque de una instalación nueva del escritorio, antes del
-- primer login (resolveBranchId() en main.js).
GRANT SELECT ON public.branches TO anon, authenticated;
