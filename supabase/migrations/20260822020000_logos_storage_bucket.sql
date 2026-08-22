-- Ajustes SaaS: bucket público para el logo del negocio. settings NO
-- necesita columnas nuevas (es key-value: logo_url/logo_updated_at/
-- theme_auto/etc. se guardan como filas normales vía set_setting, igual que
-- business_name o printer_name) -- lo único que sí requiere DDL real es el
-- bucket de Storage donde vive la imagen.
INSERT INTO storage.buckets (id, name, public)
VALUES ('logos', 'logos', true)
ON CONFLICT (id) DO NOTHING;

-- Igual que el resto de la app (anon key, sin auth de usuarios reales):
-- lectura pública (el logo se sirve en pantallas sin sesión, como login) y
-- escritura abierta a anon en este bucket específico -- mismo nivel de
-- confianza que ya tienen sales/waste/etc. antes de RLS granular.
DROP POLICY IF EXISTS "logos_public_read" ON storage.objects;
CREATE POLICY "logos_public_read" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'logos');

DROP POLICY IF EXISTS "logos_anon_write" ON storage.objects;
CREATE POLICY "logos_anon_write" ON storage.objects
  FOR INSERT TO anon, authenticated
  WITH CHECK (bucket_id = 'logos');

DROP POLICY IF EXISTS "logos_anon_update" ON storage.objects;
CREATE POLICY "logos_anon_update" ON storage.objects
  FOR UPDATE TO anon, authenticated
  USING (bucket_id = 'logos')
  WITH CHECK (bucket_id = 'logos');
