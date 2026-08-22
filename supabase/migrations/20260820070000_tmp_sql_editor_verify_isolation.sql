-- TEMPORAL -- no es una migración, es un script para pegar en el SQL
-- Editor de Supabase y correr a mano (complementa
-- scripts/verify-branch-isolation.js, que es el que de verdad importa
-- porque usa la anon key real por HTTP; esto es un sanity check rápido
-- dentro de la base). El SQL Editor corre como `postgres` (bypassea RLS)
-- salvo que le digas explícitamente que actúe como `anon`.

-- 1) Confirma que las tablas objetivo tienen RLS habilitado y las 4
--    policies esperadas (…_select_anon, …_insert_deny_anon,
--    …_update_deny_anon, …_delete_deny_anon).
SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('sales', 'sale_items', 'employees', 'drivers', 'waste', 'promotions')
ORDER BY tablename, cmd;

-- 2) Como anon: SELECT debe funcionar (Fase 1, a propósito), INSERT/UPDATE/
--    DELETE directo NO.
BEGIN;
SET LOCAL ROLE anon;

  -- Debe devolver filas (deuda pendiente documentada, no es un bug).
  SELECT count(*) AS deberia_ser_mayor_a_cero FROM public.sales;

  -- Debe fallar con "new row violates row-level security policy".
  DO $$
  BEGIN
    INSERT INTO public.sales (branch_id, folio, client_type, payment_method, total, status)
    VALUES (1, 'TEST-RLS', 'Mesa', 'efectivo', 0, 'abierta');
    RAISE EXCEPTION 'FALLO: el INSERT directo a sales NO debería haber pasado';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK: INSERT directo a sales bloqueado por RLS.';
  END $$;

  -- No lanza excepción, pero debe afectar 0 filas -- USING(false) filtra
  -- todo antes del UPDATE, no truena.
  WITH updated AS (
    UPDATE public.sales SET printed = true WHERE true RETURNING id
  )
  SELECT count(*) AS filas_actualizadas_deberia_ser_cero FROM updated;

ROLLBACK;

-- 3) IDOR cruzado a nivel RPC: reemplaza 1 por un branch_id real y 999999
--    por el id de un sale_item que SEPAS que pertenece a OTRA sucursal
--    (usa scripts/verify-branch-isolation.js si no tienes uno a la mano --
--    ese script crea y limpia sus propios datos de prueba).
-- SELECT public.comanda_update_item_qty(1, 999999, 5); -- debe lanzar EXCEPTION
