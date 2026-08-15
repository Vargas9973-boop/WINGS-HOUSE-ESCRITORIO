-- sales tiene RLS habilitado con solo dos políticas (sales_insert_web para
-- INSERT y sales_select_anon para SELECT). db.markSalePrinted() hace un
-- UPDATE directo (no vía RPC) sobre sales.printed cuando se imprime un
-- ticket, y no existe ninguna política de UPDATE para anon: el UPDATE no
-- truena (no hay error), pero RLS filtra la fila y "printed" nunca cambia.
-- Se agrega la política de UPDATE que falta, igual que sales_select_anon.
CREATE POLICY "sales_update_anon" ON public.sales
  FOR UPDATE TO anon
  USING (true)
  WITH CHECK (true);
