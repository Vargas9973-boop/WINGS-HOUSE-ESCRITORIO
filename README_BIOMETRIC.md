# Lector de huella biométrico — Asistencia

El módulo de Asistencia soporta (opcionalmente) un lector de huella USB para
registrar entrada/salida. **Por defecto está deshabilitado** y todo sigue
funcionando exactamente igual que hoy (botón "Registrar entrada/salida"). Si
no hay lector conectado, o el lector se desconecta, el sistema cae siempre al
registro manual — nunca bloquea la asistencia.

## Estado actual de la integración

Lo que ya funciona:
- Ajustes → **Asistencia/Biometría**: activar/desactivar, elegir modelo,
  probar conexión del lector.
- Detección de hardware conectado por USB (HID) para los 3 modelos
  recomendados abajo.
- Asistencia → Registrar asistencia: indicador "● Conectado / ○ No
  conectado" y la animación "Coloque su dedo" cuando hay lector.
- Asistencia → Empleados: botón "Registrar huella" por empleado (solo visible
  si el lector está habilitado en Ajustes).
- Columnas `employees.fingerprint_template` / `employees.fingerprint_enrolled`
  en la base de datos.

Lo que **falta** (a propósito, es la siguiente fase):
- Captura real de la huella y comparación (matching) contra la plantilla
  guardada. Eso depende del SDK propietario de cada fabricante — ver
  `biometric/drivers/README.md` para el punto de enganche
  (`attendanceProvider.js`). Hoy, si el lector está conectado, el botón
  "Registrar huella" y la identificación automática muestran un mensaje
  claro de "falta instalar el SDK del fabricante" en vez de simular una
  lectura.

## 3 lectores recomendados (< $100 USD en Mercado Libre)

| Modelo | SDK necesario | Precio aprox. (MX, Mercado Libre) | Notas |
|---|---|---|---|
| **DigitalPersona U.are.U 4500** | DigitalPersona SDK (gratis, HID Global) | ~$450–$900 MXN (~$25–$50 USD) | El más común en México, muchos sistemas de asistencia ya lo soportan. Buen soporte en Windows. |
| **ZKTeco ZK4500** | ZKFinger SDK v5.0 (gratis, ZKTeco) | ~$400–$800 MXN (~$22–$45 USD) | Muy usado en control de acceso; SDK con ejemplos en C++/C#. |
| **SecuGen Hamster Pro** | SecuGen FDx SDK Pro (gratis con registro) | ~$900–$1,700 MXN (~$50–$95 USD) | Mejor calidad de sensor óptico de los tres; SDK más orientado a integraciones comerciales/bancarias. |

Los tres están dentro del presupuesto (<$100 USD) y son plug-and-play por
USB — no necesitan fuente de poder aparte.

## Cómo activarlo (una vez que el SDK esté integrado)

1. Conecta el lector por USB.
2. Ajustes → **Asistencia/Biometría** → marca "Habilitar lector de huella
   biométrico", elige el modelo exacto, guarda.
3. Click en "Probar conexión lector" para confirmar que Windows/el sistema
   ve el dispositivo (esto ya funciona hoy, sin necesidad del SDK — solo
   detecta que el USB está conectado).
4. Asistencia → Empleados → "Registrar huella" en cada empleado que vaya a
   usar el lector.
5. Asistencia → Registrar asistencia: con el lector conectado y habilitado,
   la pantalla cambia automáticamente al modo "Coloque su dedo".

Si en cualquier momento el lector se desconecta o se deshabilita en Ajustes,
la pantalla vuelve sola al modo manual — no hace falta reiniciar la app.

## Para desarrolladores: siguiente paso de integración

1. Instalar el SDK del fabricante elegido (ver tabla de arriba y
   `biometric/drivers/README.md`).
2. Implementar la captura real dentro de `BiometricAttendanceProvider` en
   `attendanceProvider.js` (`enrollFingerprint` / `identify`), típicamente
   vía un addon nativo (N-API) o un proceso puente que hable con el SDK.
3. `enrollFingerprint(employeeId)` debe devolver la plantilla capturada;
   `main.js` ya la persiste con `db.saveFingerprint(employeeId, template)`.
4. `identify()` debe comparar contra `employees.fingerprint_template` de los
   empleados con `fingerprint_enrolled = true` y devolver el `employeeId`
   que coincida.
5. Correr la migración `supabase/migrations/20260818000000_biometric_fingerprint.sql`
   contra la base de datos (agrega las columnas de huella a `employees`) si
   todavía no se aplicó.

`node-hid` ya está instalado (`package.json`) y solo se usa para *detectar*
que hay un dispositivo USB conectado por vendor/product ID — no captura
huellas por sí solo, eso siempre requiere el SDK propietario del fabricante.
