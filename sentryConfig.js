// Resuelve el DSN de Sentry con el mismo criterio que supabaseConfig.js:
// env real > .env > config.json fuera del asar > sin configurar (Sentry
// simplemente no se inicializa -- ver main.js). Así una instalación sin
// DSN configurado sigue funcionando exactamente igual que hoy, sin
// romperse por falta de monitoreo.
const path = require('path');
const fs = require('fs');

require('dotenv').config();

function readConfigJson() {
  let candidates = [path.join(__dirname, 'config.json')];
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) {
      candidates = [path.join(process.resourcesPath, 'config.json')];
    }
  } catch (_) {
    // fuera de un proceso de Electron -- se usa el config.json del proyecto.
  }

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        console.error(`config.json inválido en ${file}:`, err.message);
      }
    }
  }
  return null;
}

const fileConfig = readConfigJson() || {};

const SENTRY_DSN = process.env.SENTRY_DSN || fileConfig.sentryDsn || null;

// Inicializa Sentry en un proceso de renderer (preload.js/kds-preload.js/
// report-preload.js/history-print-preload.js/ticket-preload.js) -- estos
// scripts corren con acceso a Node/ipcRenderer aunque contextIsolation esté
// activo, así que @sentry/electron/renderer puede mandar los eventos por
// IPC al proceso principal (ya inicializado en main.js) sin necesitar el
// puente de contextBridge que hace falta cuando el bundle del renderer no
// tiene acceso a Node. Cada ventana ejecuta su propio preload de cero en
// cada `loadFile`/navegación, así que esto no duplica el init en un mismo
// contexto. Sin DSN configurado, no hace nada -- mismo criterio que main.js.
function initRendererSentry() {
  if (!SENTRY_DSN) return;
  let version = 'unknown';
  try {
    version = require('./package.json').version;
  } catch (_) {
    // sin package.json accesible (no debería pasar): sigue sin romper nada.
  }
  const Sentry = require('@sentry/electron/renderer');
  Sentry.init({
    dsn: SENTRY_DSN,
    tracesSampleRate: 1.0,
    release: `wings-house@${version}`
  });
}

module.exports = { SENTRY_DSN, initRendererSentry };
