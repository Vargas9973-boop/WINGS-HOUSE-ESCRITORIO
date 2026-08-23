-- Bug real encontrado al levantar la app real para probar el wiring de
-- Sentry (no relacionado con monitoreo -- se encontró de pura casualidad
-- al correr npm start por primera vez desde la fase 1 de RLS): db.init()
-- corre en CADA arranque, ANTES de cualquier login, así que
-- seedUsersIfEmpty() se ejecuta como anon. Desde
-- 20260822120000_rls_restrictive_phase1.sql, `users` es SELECT/INSERT
-- solo para `authenticated` -- el conteo "¿está vacía la tabla?" ahora
-- siempre ve 0 filas para anon (aunque haya usuarios reales), así que
-- intenta re-sembrar en cada arranque y truena contra la policy de
-- INSERT. db.init() no es fatal (main.js solo loggea el error y sigue),
-- pero además de ensuciar los logs (y ahora Sentry) en cada arranque,
-- deja a migrateAlitasBonelessCategories() sin ejecutarse nunca -- init()
-- no tiene try/catch interno, el throw de seedUsersIfEmpty() corta la
-- siguiente línea.
--
-- Fix: mover el chequeo Y el insert a RPCs SECURITY DEFINER (bypasean
-- RLS), igual que el resto de las escrituras de la app. Sigue siendo
-- exactamente el mismo comportamiento de siempre para una instalación con
-- usuarios ya sembrados (no-op) -- la diferencia es que ahora el no-op se
-- puede verificar sin necesitar sesión.

CREATE OR REPLACE FUNCTION public.users_table_row_count()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*) FROM public.users;
$$;

GRANT EXECUTE ON FUNCTION public.users_table_row_count() TO anon, authenticated;

-- Re-chequea adentro (no solo confía en que el llamador ya vio count=0)
-- para que sea seguro llamarla siempre, sin condición de carrera entre el
-- chequeo externo y el insert.
CREATE OR REPLACE FUNCTION public.seed_default_user(
  p_username text, p_name text, p_role text,
  p_password_hash text, p_password_salt text, p_branch_id bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.users LIMIT 1) THEN
    RETURN;
  END IF;
  INSERT INTO public.users (username, name, role, password_hash, password_salt, branch_id)
  VALUES (p_username, p_name, p_role, p_password_hash, p_password_salt, p_branch_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.seed_default_user(text, text, text, text, text, bigint) TO anon, authenticated;
