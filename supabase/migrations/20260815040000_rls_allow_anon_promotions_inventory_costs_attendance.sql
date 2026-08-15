-- RLS está habilitado en promotions, inventory, costs y attendance pero sin
-- ninguna política — bloquea incluso SELECT para el cliente de la app, que
-- se conecta con la llave publishable (rol anon), no con service_role.
CREATE POLICY "allow_anon_all" ON public.promotions FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "allow_anon_all" ON public.inventory FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "allow_anon_all" ON public.costs FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "allow_anon_all" ON public.attendance FOR ALL TO anon USING (true) WITH CHECK (true);
