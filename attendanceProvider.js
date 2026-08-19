// attendanceProvider.js — Abstracción de registro de asistencia (proceso
// principal de Electron). Hoy solo existe el registro manual (botón en
// Asistencia); este módulo prepara el terreno para un lector de huella
// biométrico sin tocar el flujo manual que ya funciona:
//
//   interface AttendanceProvider {
//     checkIn(employeeId)        -> registra entrada/salida (igual que hoy)
//     enrollFingerprint(employeeId) -> captura y guarda la huella de un empleado
//     identify()                 -> lee el lector y resuelve a un employeeId
//   }
//
// getAttendanceProvider(db, settings) decide en tiempo de ejecución cuál
// implementación usar: si Ajustes tiene biometric_enabled.enabled=true Y hay
// un lector físico detectado, usa BiometricAttendanceProvider; en cualquier
// otro caso (deshabilitado, sin lector, SDK no instalado) cae a
// ManualAttendanceProvider — el registro manual sigue disponible siempre.
//
// node-hid solo permite *detectar* que hay un lector USB conectado (por
// vendor/product ID). La captura y el matcheo real de la huella dependen del
// SDK propietario de cada fabricante (DigitalPersona SDK, ZKFinger SDK,
// SecuGen FDx SDK) — ninguno de esos SDKs está integrado todavía. Por eso
// enrollFingerprint()/identify() del proveedor biométrico son el punto de
// enganche para esa integración futura: hoy detectan el hardware y devuelven
// un error claro en vez de fingir que capturaron una huella real. Ver
// biometric/drivers/README.md.

// require() defensivo: si node-hid no está instalado o su binario nativo no
// carga en este Electron/SO, el módulo entero debe seguir funcionando en
// modo manual — nunca debe tumbar la app por esto.
let HID = null;
try {
  HID = require('node-hid');
} catch (err) {
  console.warn('[attendanceProvider] node-hid no disponible, modo manual únicamente:', err.message);
}

// IDs de referencia (vendorId/productId) reportados públicamente para estos
// modelos. Confirmar contra el dispositivo real antes de depender de ellos
// en producción: un falso negativo aquí solo implica "sigue en modo manual"
// (seguro); un falso positivo implicaría creer que hay lector cuando no lo
// hay, por lo que solo se usan para detección informativa, nunca para
// bloquear el registro manual.
const KNOWN_DEVICES = {
  u_are_u_4500: [{ vendorId: 0x05ba, productId: 0x000a }], // DigitalPersona U.are.U 4500
  zk4500: [{ vendorId: 0x1b55, productId: 0x0840 }],        // ZKTeco ZK4500
  hamster_pro: [{ vendorId: 0x1162, productId: 0x2201 }]    // SecuGen Hamster Pro
};

const BIOMETRIC_MODELS = [
  { value: 'u_are_u_4500', label: 'DigitalPersona U.are.U 4500' },
  { value: 'zk4500', label: 'ZKTeco ZK4500' },
  { value: 'hamster_pro', label: 'SecuGen Hamster Pro' },
  { value: 'generico', label: 'Genérico (HID)' }
];

// Devuelve el dispositivo HID conectado que coincide con el modelo pedido
// (o con cualquiera de los tres modelos conocidos si model es 'generico' /
// no reconocido). null si no hay lector conectado o si node-hid no cargó.
function findConnectedDevice(model) {
  if (!HID) return null;
  let devices;
  try {
    devices = HID.devices();
  } catch (err) {
    console.warn('[attendanceProvider] No se pudo enumerar dispositivos HID:', err.message);
    return null;
  }

  const candidates = KNOWN_DEVICES[model]
    ? KNOWN_DEVICES[model]
    : Object.values(KNOWN_DEVICES).flat();

  return (
    devices.find((d) =>
      candidates.some((c) => d.vendorId === c.vendorId && d.productId === c.productId)
    ) || null
  );
}

function isDeviceConnected(model) {
  return !!findConnectedDevice(model);
}

// ------------------------------------------------------------------
// Proveedor manual — el flujo actual, sin cambios de comportamiento.
// ------------------------------------------------------------------
class ManualAttendanceProvider {
  constructor(db) {
    this.db = db;
    this.kind = 'manual';
  }

  async checkIn(employeeId) {
    return this.db.registerAttendance(employeeId);
  }

  async enrollFingerprint() {
    throw new Error('El registro de huella requiere habilitar el lector biométrico en Ajustes.');
  }

  async identify() {
    throw new Error('La identificación por huella no está disponible en modo manual.');
  }
}

// ------------------------------------------------------------------
// Proveedor biométrico — wrapper para el SDK nativo del lector. La captura
// real de huella (enroll/identify) requiere el SDK del fabricante instalado;
// hasta entonces expone detección de hardware y errores claros en vez de
// simular una lectura.
// ------------------------------------------------------------------
class BiometricAttendanceProvider {
  constructor(db, model) {
    this.db = db;
    this.model = model;
    this.kind = 'biometric';
  }

  async checkIn(employeeId) {
    // El check-in en sí es el mismo registro que el modo manual; lo único
    // que cambia es cómo se obtuvo el employeeId (por huella vía identify()
    // en vez de tocar un botón).
    return this.db.registerAttendance(employeeId);
  }

  async enrollFingerprint(employeeId) {
    if (!isDeviceConnected(this.model)) {
      throw new Error('No se detecta el lector de huella conectado.');
    }
    throw new Error(
      'Captura de huella no implementada: falta instalar el SDK del fabricante ' +
      '(ver biometric/drivers/README.md). El lector se detecta correctamente, ' +
      'pero la captura/almacenado de la plantilla requiere esa integración.'
    );
  }

  async identify() {
    if (!isDeviceConnected(this.model)) {
      return { connected: false };
    }
    throw new Error(
      'Identificación por huella no implementada: falta instalar el SDK del fabricante ' +
      '(ver biometric/drivers/README.md).'
    );
  }
}

// settings: objeto ya parseado { enabled, model } (ver getBiometricSettings
// en db.js). Nunca lanza: ante cualquier duda devuelve el proveedor manual.
function getAttendanceProvider(db, settings) {
  const enabled = !!(settings && settings.enabled);
  const model = (settings && settings.model) || 'generico';
  if (enabled && isDeviceConnected(model)) {
    return new BiometricAttendanceProvider(db, model);
  }
  return new ManualAttendanceProvider(db);
}

module.exports = {
  ManualAttendanceProvider,
  BiometricAttendanceProvider,
  getAttendanceProvider,
  isDeviceConnected,
  findConnectedDevice,
  BIOMETRIC_MODELS
};
