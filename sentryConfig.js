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

module.exports = { SENTRY_DSN };
