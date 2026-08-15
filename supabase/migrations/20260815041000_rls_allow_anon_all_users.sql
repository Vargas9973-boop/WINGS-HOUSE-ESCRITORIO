DROP POLICY IF EXISTS "Allow all for anon" ON public.users;

CREATE POLICY "Allow all for anon" ON public.users FOR ALL TO anon USING (true) WITH CHECK (true);
