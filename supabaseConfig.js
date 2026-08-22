// Resuelve SUPABASE_URL/SUPABASE_ANON_KEY sin hardcodearlos en el código
// fuente (antes vivían como const en supabaseClient.js -- todo build del
// escritorio apuntaba al mismo backend sin poder cambiarlo sin recompilar).
//
// Orden de resolución (el primero que aparezca gana):
//   1. Variables de entorno reales (SUPABASE_URL / SUPABASE_ANON_KEY).
//   2. .env en la carpeta del proyecto/instalación (vía dotenv).
//   3. config.json fuera del asar (extraResources en electron-builder) --
//      permite que un build para OTRO cliente/tenant apunte a otro
//      proyecto de Supabase con solo reemplazar ese archivo, sin tocar
//      código ni recompilar.
//   4. Fallback a los valores que ya estaban hardcodeados, para que las
//      instalaciones existentes de Wings House sigan funcionando igual
//      sin necesitar ningún archivo nuevo.
const path = require('path');
const fs = require('fs');

require('dotenv').config();

const LEGACY_DEFAULT_URL = 'https://acvsmyvijzqredqmoxti.supabase.co';
const LEGACY_DEFAULT_ANON_KEY = 'sb_publishable_2p9rJ5x8CQWrC-yIlu99mw_Gn2ZsHl9';

function readConfigJson() {
  let candidates = [path.join(__dirname, 'config.json')];
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) {
      candidates = [path.join(process.resourcesPath, 'config.json')];
    }
  } catch (_) {
    // fuera de un proceso de Electron (ej. scripts/test-supabase.js) -- se
    // usa el config.json de la carpeta del proyecto si existe.
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

const SUPABASE_URL =
  process.env.SUPABASE_URL || fileConfig.supabaseUrl || LEGACY_DEFAULT_URL;

const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || fileConfig.supabaseAnonKey || LEGACY_DEFAULT_ANON_KEY;

module.exports = { SUPABASE_URL, SUPABASE_ANON_KEY };
