-- Aislamiento real por sucursal: settings era una tabla key-value GLOBAL
-- (sin branch_id) -- logo_url/theme_auto/theme_colors/benefit_*/
-- weekly_credit_* (Ajustes SaaS, 2026-08-22) y TODO lo demás
-- (business_name, printer_name, payroll_payday, biometric_enabled, etc.)
-- se guardaban en una sola fila por key, compartida por cualquier
-- sucursal. Con una sola sucursal real esto era invisible; con una
-- segunda, ambas verían el mismo logo/tema/beneficio.
--
-- set_setting() (el RPC que hace el upsert de escritura) es "caja negra"
-- -- nunca versionado en este repo (ver 20260820080000_catalog_by_branch.sql,
-- que ya lo señalaba). No se reescribe a ciegas. En vez de eso, settings
-- YA tiene una policy RLS abierta a anon desde
-- 20260817020000_settings_rls_policy.sql ("allow_anon_all" FOR ALL
-- USING(true) WITH CHECK(true)) -- db.js deja de llamar al RPC para
-- escribir y hace el upsert directo contra la tabla (ya permitido por esa
-- policy), rodeando el RPC desconocido por completo en vez de adivinar su
-- cuerpo.

-- Si existe una constraint UNIQUE/PK solo sobre (key), se quita: el nuevo
-- UNIQUE real es (key, branch_id). Se busca dinámicamente en vez de
-- adivinar el nombre (mismo motivo que el resto de las migraciones de este
-- repo: no asumir un esquema no verificado).
DO $$
DECLARE
  v_conname text;
BEGIN
  SELECT con.conname INTO v_conname
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'settings'
    AND con.contype IN ('u', 'p')
    AND (
      SELECT array_agg(attname::text ORDER BY attnum)
      FROM pg_attribute
      WHERE attrelid = con.conrelid AND attnum = ANY(con.conkey)
    ) = ARRAY['key']::text[]
  LIMIT 1;

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.settings DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS branch_id bigint REFERENCES public.branches(id);

-- Por si acaso hubiera duplicados exactos de key (no debería -- set_setting
-- ya hacía upsert por key), nos quedamos con la fila más reciente por ctid
-- antes de exigir unicidad por (key, branch_id).
DELETE FROM public.settings a
USING public.settings b
WHERE a.key = b.key
  AND a.ctid < b.ctid;

-- Backfill: las filas existentes (huérfanas, branch_id NULL) van a la
-- primera sucursal real; para CUALQUIER otra sucursal que ya exista, se
-- clona el snapshot actual (para que ninguna arranque con Ajustes vacío,
-- cada una queda libre de configurarse distinto desde ahí en adelante).
DO $$
DECLARE
  v_first_branch bigint;
  v_branch record;
BEGIN
  SELECT id INTO v_first_branch FROM public.branches ORDER BY id LIMIT 1;

  UPDATE public.settings SET branch_id = v_first_branch WHERE branch_id IS NULL;

  FOR v_branch IN SELECT id FROM public.branches WHERE id <> v_first_branch LOOP
    INSERT INTO public.settings (key, value, branch_id)
    SELECT s.key, s.value, v_branch.id
    FROM public.settings s
    WHERE s.branch_id = v_first_branch
      AND NOT EXISTS (
        SELECT 1 FROM public.settings s2 WHERE s2.key = s.key AND s2.branch_id = v_branch.id
      );
  END LOOP;
END $$;

ALTER TABLE public.settings ALTER COLUMN branch_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'settings_key_branch_unique'
  ) THEN
    ALTER TABLE public.settings
      ADD CONSTRAINT settings_key_branch_unique UNIQUE (key, branch_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_settings_branch ON public.settings (branch_id);
