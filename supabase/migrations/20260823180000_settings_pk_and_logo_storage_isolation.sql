-- Auditoría de Ajustes 2026-08-23: 2 hallazgos reales, ambos directamente
-- relevantes para "vender la siguiente licencia" (segunda sucursal/tenant).
--
-- 1) settings todavía tiene su PRIMARY KEY (key) original, de cuando la
--    tabla era global de toda la instalación -- además del
--    UNIQUE (key, branch_id) real que se agregó cuando se hizo per-branch.
--    set_branch_setting hace `INSERT ... ON CONFLICT (key, branch_id) DO
--    UPDATE`, pero ese ON CONFLICT solo resuelve conflictos contra el
--    arbiter (key, branch_id) -- la violación de settings_pkey (key) sola
--    es una constraint DISTINTA y no la cubre. Con 1 sola sucursal en toda
--    la base hoy nunca se dispara, pero en cuanto exista una segunda
--    sucursal/negocio, guardar CUALQUIER ajuste (nombre del negocio, logo,
--    beneficio diario, tema) en esa segunda sucursal truena con
--    "duplicate key value violates unique constraint settings_pkey" --
--    bloquea Ajustes por completo para el segundo cliente desde el primer
--    día. Fix: la PK pasa a ser la compuesta real; el UNIQUE viejo (ahora
--    redundante con la PK) se elimina.
ALTER TABLE public.settings DROP CONSTRAINT settings_pkey;
ALTER TABLE public.settings DROP CONSTRAINT settings_key_branch_unique;
ALTER TABLE public.settings ADD PRIMARY KEY (key, branch_id);

-- 2) Bucket de Storage "logos": logos_anon_write/logos_anon_update solo
--    validaban bucket_id='logos', sin restringir el path -- otorgadas a
--    anon Y authenticated. uploadLogo() ya sube a `{branch_id}/logo-...`,
--    pero la policy nunca lo exigía: cualquiera con la anon key pública
--    (sin login, embebida en el instalador) podía subir/sobreescribir el
--    logo de CUALQUIER sucursal o negocio navegando el path a mano. Fix:
--    exige que el primer segmento del path coincida con la sucursal de la
--    sesión real (current_branch_id()); anon queda fuera por completo
--    (ya no hace falta -- uploadLogo() siempre corre con sesión real).
DROP POLICY IF EXISTS logos_anon_write ON storage.objects;
DROP POLICY IF EXISTS logos_anon_update ON storage.objects;

CREATE POLICY logos_write_own_branch ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'logos'
    AND (storage.foldername(name))[1] = public.current_branch_id()::text
  );

CREATE POLICY logos_update_own_branch ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'logos'
    AND (storage.foldername(name))[1] = public.current_branch_id()::text
  )
  WITH CHECK (
    bucket_id = 'logos'
    AND (storage.foldername(name))[1] = public.current_branch_id()::text
  );
