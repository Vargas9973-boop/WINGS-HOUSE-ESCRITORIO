-- Prepara employees para el lector de huella biométrico (Ajustes ->
-- Asistencia/Biometría). No se activa nada por sí sola: mientras
-- biometric_enabled.enabled sea false (default) o no haya lector detectado,
-- el sistema sigue en registro manual exactamente igual que hoy.

ALTER TABLE public.employees
ADD COLUMN IF NOT EXISTS fingerprint_template TEXT;

ALTER TABLE public.employees
ADD COLUMN IF NOT EXISTS fingerprint_enrolled BOOLEAN DEFAULT FALSE;
