-- Limpieza pedida tras el audit SaaS: `accounts` (tabla legacy, 1 fila,
-- cero código la usa en ninguna de las dos apps -- confirmado con grep) y
-- `users.password` (columna legacy NOT NULL, guardaba el hash en
-- sincronía con password_hash desde hace tiempo, nunca texto plano --
-- confirmado: 0 filas con password_hash null). Verificado antes de esto:
-- sin FKs apuntando a accounts, sin vistas/funciones dependiendo de
-- ninguna de las dos. db.js ya no escribe `password` en ningún insert/
-- update de users (seedUsersIfEmpty/changePassword/createUser/updateUser
-- actualizados en el mismo commit) -- dropear la columna sin eso hubiera
-- roto esas 4 funciones en el primer request.

DROP TABLE public.accounts;

ALTER TABLE public.users DROP COLUMN password;
