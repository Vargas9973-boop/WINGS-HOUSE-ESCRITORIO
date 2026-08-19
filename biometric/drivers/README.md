# /biometric/drivers

Carpeta vacía a propósito: aquí van los binarios/bindings nativos del SDK del
fabricante cuando se integre la captura real de huella (`enrollFingerprint`
/ `identify` en `attendanceProvider.js`, hoy son stubs que detectan el
hardware pero no capturan la huella — ver el comentario al inicio de ese
archivo).

Ningún archivo de esta carpeta se sube al build de Electron todavía; no hay
`require()` apuntando aquí. Es el lugar reservado para cuando se instale uno
de estos SDKs:

## DigitalPersona U.are.U 4500
- Necesita: **DigitalPersona SDK** (gratuito, de HID Global / Crossmatch).
- Descarga: sitio de HID Global / DigitalPersona Developer Center (requiere
  registro gratuito).
- Trae bindings para Windows (.dll) y un SDK en C/C#/Java; para Node/Electron
  normalmente se usa vía un addon nativo (N-API) que envuelva la DLL, o
  exponiendo un servicio local (REST/WebSocket) que el SDK sí soporta
  oficialmente y que Electron consume por HTTP.
- Colocar aquí: las DLLs del SDK (`dpfpdd.dll`, `dpfj.dll`, etc.) y el addon
  nativo una vez compilado.

## ZKTeco ZK4500
- Necesita: **ZKFinger SDK v5.0** (gratuito, del sitio oficial de ZKTeco /
  ZKTeco Biometrics).
- Trae un SDK en C++ con bindings de ejemplo; igual que DigitalPersona, la
  ruta más simple para Electron es un addon nativo o un puente por proceso
  hijo que hable con el SDK y devuelva la plantilla/resultado por stdout o
  IPC local.
- Colocar aquí: `libzkfp.dll`/`.so` del SDK y el addon una vez compilado.

## SecuGen Hamster Pro
- Necesita: **SecuGen FDx SDK Pro** (gratuito con registro, de secugen.com).
- Igual patrón: SDK nativo (C/C++) + addon o puente de proceso para hablar
  con Electron.

## Patrón de integración sugerido

`attendanceProvider.js` ya tiene el punto de enganche:

```js
class BiometricAttendanceProvider {
  async enrollFingerprint(employeeId) { /* aquí llamar al SDK real */ }
  async identify() { /* aquí llamar al SDK real */ }
}
```

Al integrar un SDK real, esos dos métodos deben:
1. Capturar la huella con el SDK del fabricante.
2. `enrollFingerprint` -> devolver la plantilla (string/base64) para que
   `main.js` la guarde con `db.saveFingerprint(employeeId, template)`.
3. `identify` -> comparar contra las plantillas guardadas
   (`employees.fingerprint_template`) y devolver el `employeeId` que
   coincida, o `{ connected: true, matched: false }` si no hay coincidencia.

Mientras no se integre ningún SDK, el sistema sigue funcionando 100% en modo
manual (botón "Registrar entrada/salida"); esta carpeta y el módulo
`attendanceProvider.js` son solo la base para cuando se instale el hardware.
