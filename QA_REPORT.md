# QA Report — Alerta de cocina (wings-house-web ↔ wings-house-desktop)

Fecha: 2026-08-15
Alcance: CSP, polling híbrido y deduplicación de la alerta de cocina.
**No se tocó**: `db.js` función `login`, tabla `public.users`, RLS de `users`, autenticación, ni la lógica de creación de `sales`/`sale_items`.

## ACCIÓN MANUAL REQUERIDA (no aplicada por QA)

La app espera que la tabla `public.sales` esté agregada a la publicación de Realtime.
Si la alerta de cocina no llega vía websocket (solo vía el polling de respaldo), corre esto una vez en el SQL editor de Supabase:

```sql
alter publication supabase_realtime add table public.sales;
```

Esto **no se aplicó automáticamente** — es una operación sobre infraestructura compartida (Supabase) y debe aplicarla el usuario.

## Objetivo 1 — CSP `connect-src`

Se revisaron las 14 páginas HTML con `<meta http-equiv="Content-Security-Policy">`. Antes, solo `login.html` e `index.html` tenían `connect-src`, y les faltaba `https://*.supabase.in`. Las otras 12 no tenían `connect-src` en absoluto, por lo que caían en `default-src 'self'`, bloqueando cualquier llamada de red/websocket a Supabase desde el renderer.

Se agregó/completó en las 14 páginas:
```
connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.supabase.in;
```

Archivos: `login.html`, `index.html` (solo se agregó el dominio `.in` faltante), `comandas.html`, `sales.html`, `catalog.html`, `inventory.html`, `waste.html`, `costs.html`, `reports.html`, `attendance.html`, `accounts.html`, `settings.html`, `report-print.html`, `ticket.html`.

No se creó CSP en ninguna página que no la tuviera ya (ninguna estaba en ese caso).

## Objetivo 2 — Polling híbrido (fallback, no principal)

- `db.js`: `subscribeToNewSales(onInsert, onStatusChange)` ahora acepta un callback de estado y lo invoca con `(connected, status, err)` en cada cambio de estado del canal Realtime (`SUBSCRIBED` → `true`, `CHANNEL_ERROR`/`TIMED_OUT`/`CLOSED` → `false`).
- `main.js`: nueva variable `isRealtimeConnected`, actualizada desde ese callback y transmitida al renderer vía IPC `order-alert:status`. Se agregó `order-alert:getStatus` (invoke) para que una página recién cargada (recuerda: `main.js` hace `loadFile` completo en cada navegación) pueda preguntar el estado actual sin esperar el próximo cambio.
- `comandas-renderer.js`: nuevas variables `isRealtimeConnected` y `notifiedSaleIds`. Nueva función `fetchComandas()`:
  - Si `isRealtimeConnected === true` → no hace nada (Realtime manda).
  - Si `isRealtimeConnected === false` → revisa `comandasAPI.getTables()` cada `AUTO_REFRESH_MS` (3s) buscando mesas ocupadas cuyo `saleId` no esté ya en `notifiedSaleIds`, y las reporta a `main.js`.
  - El intervalo (`fallbackAlertInterval`) se detiene por completo cuando Realtime está conectado y se reactiva cada 3s cuando se cae — no es un polling permanente, es un fallback real.
  - Se agregó el badge visual "Conectado"/"Desconectado" (`#realtime-status` en `comandas.html`, estilos en `comandas.css`).

El polling existente del mapa de mesas y de la comanda abierta (`tablesRefreshInterval` / `orderRefreshInterval`, UI general) **no se tocó** — sigue actualizando la pantalla igual que antes, para no arriesgar una regresión visual entre estaciones distintas.

## Objetivo 3 — Evitar doble sonido

- `main.js`: `handleIncomingSale(row, viaFallback)` es el único punto que dispara la alerta (banner + sonido vía `order-alert:start`), tanto para eventos genuinos de Realtime como para reportes del polling de respaldo (`order-alert:fallback-sale` → mismo filtro). Se agregó `console.log('🔕 Ignorado duplicado:', id)` en los dos puntos de corte: ID autogenerado por esta misma instalación (`selfCreatedSaleIds`) e ID visto recientemente (`recentSaleAlertIds`, debounce de 3s).
- `comandas-renderer.js`: antes de reportar una mesa ocupada al proceso principal, se verifica `notifiedSaleIds`; si ya está, se loguea `🔕 Ignorado duplicado: <id>` y no se reenvía. Cuando llega `order-alert:new-sale` (aviso de que Realtime ya notificó ese ID), se agrega a `notifiedSaleIds` para que el polling de respaldo no lo repita si Realtime se cae poco después.

No se duplicó lógica de sonido en `comandas-renderer.js`: el chime sigue viviendo únicamente en `order-alert.js`, que reacciona al mismo evento `order-alert:start` sin importar si el origen fue Realtime o el fallback.

## Objetivo 4 — Verificación

- `node --check` sobre `main.js`, `db.js`, `preload.js`, `comandas-renderer.js`: sin errores de sintaxis.
- `npx electron .`: la app abre, Supabase se inicializa y el canal Realtime queda `SUBSCRIBED` ("Realtime (sales) activo: escuchando comandas nuevas.") sin errores en consola del proceso principal.
- Con `ELECTRON_ENABLE_LOGGING=1` no se observaron violaciones de CSP ni errores en consola durante la carga de `login.html`.
- **Pendiente de verificación manual por el usuario** (requiere interacción GUI que este QA no pudo automatizar): iniciar sesión con `admin@wingshouse.com` / `wingshouse14`, navegar a Comandas, confirmar que el header muestra "Conectado" en verde, y que al desconectar Internet cambia a "Desconectado" en rojo y el polling de respaldo se reactiva (revisar consola de DevTools por los logs `🔔`/`🔕`).

## Confirmación de reglas blindadas

- No se modificó `db.js` función `login` ni ninguna lógica de autenticación.
- No se modificó la tabla `public.users` ni políticas RLS.
- No se modificó `createSale`, `comandaAddItem`, `comandaCloseTable` ni ninguna lógica de creación de `sales`/`sale_items`.
- Únicos archivos tocados: CSP en las 14 páginas HTML, `db.js` (solo el callback de estado de `subscribeToNewSales`), `main.js` (estado Realtime + fallback de alerta), `preload.js` (bridge `orderAlertAPI`), `comandas-renderer.js` (polling híbrido) y `comandas.css`/`comandas.html` (badge visual).
