// npm run test:stability
//
// Chequeos estáticos (grep sobre el código fuente, no requieren levantar
// Electron) que le dan seguimiento a la auditoría de estabilidad: si algún
// cambio futuro reintroduce uno de los patrones que causaron el
// congelamiento reportado ("agregar insumo"), esto debe marcarlo en rojo
// con archivo y línea antes de que llegue a producción.
//
// OJO con el punto 1: la lista original pedía verificar que TODOS los
// renderer.js tuvieran `window.addEventListener('beforeunload', () => {
// ipcRenderer.removeAllListeners(); channel.unsubscribe() })`. Ese patrón
// no aplica a esta app: la navegación entre módulos usa
// `mainWindow.loadFile()` (ver main.js), que descarta el documento/contexto
// JS completo en cada navegación -- Chromium ya limpia listeners/intervalos
// solos, no hace falta un beforeunload manual, y ningún renderer.js de este
// repo lo tiene hoy (agregarlo a los ~15 archivos sería ruido, no una
// protección real). Lo que sí importa en esta arquitectura es que un
// setInterval no se quede sonando indefinidamente sin un clearInterval en
// alguna parte del mismo archivo -- eso es lo que se verifica abajo.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;

function fail(file, line, message) {
  failures++;
  console.log(`\x1b[31m✗ FAIL\x1b[0m ${file}:${line} -- ${message}`);
}

function ok(message) {
  console.log(`\x1b[32m✓ OK\x1b[0m ${message}`);
}

function listFirstPartyJsFiles() {
  // scripts/ queda fuera a propósito: es tooling de desarrollo (este mismo
  // archivo incluido), no código que corra en la app -- si se le exigen
  // los mismos patrones, este archivo se marca a sí mismo en rojo por
  // tener la palabra "setInterval" dentro de sus propias regex.
  const skipDirs = new Set(['node_modules', 'wing-house-web', 'dist', '.git', 'build', 'scripts']);
  const results = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        results.push(path.join(dir, entry.name));
      }
    }
  })(ROOT);
  return results;
}

function linesOf(content) {
  return content.split(/\r\n|\n/);
}

// ==========================================================================
// 1. setInterval sin clearInterval en el mismo archivo
// ==========================================================================
// Excepciones conocidas y revisadas, no un silenciador genérico:
//   - kds/kds-renderer.js: los dos setInterval (reloj + timers de las
//     tarjetas) corren en una ventana verdaderamente singleton
//     (createKDSWindow() en main.js reutiliza la ventana existente en vez
//     de recargarla -- ver auditoría de estabilidad), así que el script
//     nunca se vuelve a ejecutar sobre un contexto ya vivo. No hay nada que
//     limpiar porque nunca se duplica.
//   - attendance-renderer.js: el sondeo de estado del lector biométrico
//     (setInterval(refreshBiometricStatus, 8000)) arranca una sola vez en
//     DOMContentLoaded, sobre una sola pantalla sin sub-vistas que
//     alternar (a diferencia de comandas-renderer.js). Como toda
//     navegación fuera del módulo es mainWindow.loadFile() (recarga
//     completa de documento), Chromium tira el contexto entero solo.
//   - main.js: el log de memoria cada 30s (ver más abajo en este mismo
//     archivo) vive mientras vive el proceso principal a propósito -- no
//     hay "después" en el que limpiarlo, muere con la app.
const INTERVAL_CLEANUP_EXCEPTIONS = new Set([
  path.join(ROOT, 'kds', 'kds-renderer.js'),
  path.join(ROOT, 'attendance-renderer.js'),
  path.join(ROOT, 'main.js')
]);

function checkIntervalCleanup(files) {
  console.log('\n--- 1. setInterval sin clearInterval ---');
  let sectionOk = true;
  files.forEach((file) => {
    const content = fs.readFileSync(file, 'utf8');
    if (!/setInterval\s*\(/.test(content)) return;
    if (INTERVAL_CLEANUP_EXCEPTIONS.has(file)) return;
    if (/clearInterval\s*\(/.test(content)) return;

    sectionOk = false;
    const lines = linesOf(content);
    lines.forEach((lineText, idx) => {
      if (/setInterval\s*\(/.test(lineText)) {
        fail(path.relative(ROOT, file), idx + 1, 'setInterval sin clearInterval en todo el archivo.');
      }
    });
  });
  if (sectionOk) ok('todo setInterval tiene un clearInterval en el mismo archivo (o está en la lista de excepciones revisadas).');
}

// ==========================================================================
// 2. fs.writeFileSync en el proceso principal
// ==========================================================================
// Solo tiene sentido revisar los módulos que corren en el proceso
// principal (main.js y lo que este hace require() directo: db.js,
// attendanceProvider.js). Los *-renderer.js corren en el renderer, ahí
// fs.writeFileSync ni siquiera está disponible (nodeIntegration: false).
const MAIN_PROCESS_FILES = ['main.js', 'db.js', 'attendanceProvider.js'];

function checkNoSyncWriteInMainProcess() {
  console.log('\n--- 2. fs.writeFileSync en el proceso principal ---');
  let sectionOk = true;
  MAIN_PROCESS_FILES.forEach((relFile) => {
    const file = path.join(ROOT, relFile);
    if (!fs.existsSync(file)) return;
    const lines = linesOf(fs.readFileSync(file, 'utf8'));
    lines.forEach((lineText, idx) => {
      if (/\bfs\.writeFileSync\s*\(/.test(lineText)) {
        sectionOk = false;
        fail(relFile, idx + 1, 'fs.writeFileSync bloquea el proceso principal -- usa fs.promises.writeFile.');
      }
    });
  });
  if (sectionOk) ok(`sin fs.writeFileSync en ${MAIN_PROCESS_FILES.join(', ')}.`);
}

// ==========================================================================
// 3. innerHTML += en loop
// ==========================================================================
function checkNoInnerHtmlConcat(files) {
  console.log('\n--- 3. innerHTML += (concatenación en loop) ---');
  let sectionOk = true;
  files.forEach((file) => {
    const lines = linesOf(fs.readFileSync(file, 'utf8'));
    lines.forEach((lineText, idx) => {
      if (/\.innerHTML\s*\+=/.test(lineText)) {
        sectionOk = false;
        fail(path.relative(ROOT, file), idx + 1, 'innerHTML += -- construye el string completo (map/join) y asigna una sola vez.');
      }
    });
  });
  if (sectionOk) ok('sin innerHTML += en ningún archivo propio.');
}

// ==========================================================================
// 4. kdsWindow es singleton (una sola variable global, con guardas)
// ==========================================================================
function checkKdsWindowSingleton() {
  console.log('\n--- 4. kdsWindow singleton ---');
  const file = path.join(ROOT, 'main.js');
  const content = fs.readFileSync(file, 'utf8');
  const lines = linesOf(content);
  let sectionOk = true;

  const declLines = [];
  lines.forEach((lineText, idx) => {
    if (/^\s*let\s+kdsWindow\b/.test(lineText)) declLines.push(idx + 1);
  });

  if (declLines.length === 0) {
    sectionOk = false;
    fail('main.js', 1, 'no se encontró "let kdsWindow" -- ¿se renombró la variable?');
  } else if (declLines.length > 1) {
    sectionOk = false;
    declLines.forEach((ln) => fail('main.js', ln, 'más de una declaración de "let kdsWindow" -- ya no es una sola variable global.'));
  }

  if (!/if\s*\(\s*kdsWindow\s*&&\s*!kdsWindow\.isDestroyed\(\)\s*\)/.test(content)) {
    sectionOk = false;
    fail('main.js', declLines[0] || 1, 'createKDSWindow() ya no reutiliza la ventana existente (falta el guard "if (kdsWindow && !kdsWindow.isDestroyed())").');
  }

  if (!/kdsWindow\.on\(\s*['"]closed['"]\s*,\s*\(\)\s*=>\s*{\s*kdsWindow\s*=\s*null;?\s*}\s*\)/.test(content)) {
    sectionOk = false;
    fail('main.js', declLines[0] || 1, 'falta kdsWindow.on(\'closed\', () => { kdsWindow = null; }) -- la ventana cerrada dejaría la referencia viva.');
  }

  if (sectionOk) ok('kdsWindow es una sola variable global, con guard de reuso y reset a null al cerrar.');
}

function main() {
  const files = listFirstPartyJsFiles();
  console.log(`Revisando ${files.length} archivos .js propios...`);

  checkIntervalCleanup(files);
  checkNoSyncWriteInMainProcess();
  checkNoInnerHtmlConcat(files);
  checkKdsWindowSingleton();

  console.log('\n=================================');
  if (failures > 0) {
    console.log(`\x1b[31m${failures} chequeo(s) fallaron.\x1b[0m`);
    process.exit(1);
  } else {
    console.log('\x1b[32mTodos los chequeos de estabilidad pasaron.\x1b[0m');
    process.exit(0);
  }
}

main();
