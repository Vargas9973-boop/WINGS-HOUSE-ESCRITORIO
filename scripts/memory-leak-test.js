// npm run test:mem
//
// Simula uso pesado del proceso principal: llama repetidamente a las
// mismas funciones de db.js que usan los renderers reales (getAllSales,
// getAllInventory, getAllRecipesWithStock/getAllRecipeCosts) y mide si el
// heap crece de forma sostenida -- la firma de un leak real (algo que
// acumula referencias y nunca las suelta), a diferencia del crecimiento
// normal de arranque (cachés/JIT calentando en las primeras iteraciones).
//
// No hay mocks en este repo (ver CLAUDE.md / arquitectura del proyecto):
// corre contra la misma Supabase real que usa la app. Con pocos datos de
// producción (pensado para un solo negocio) cada iteración es barata; si
// esto se vuelve lento, es señal de que YA hace falta paginar en el propio
// db.js, no solo un problema de este script.
//
// Para una lectura más limpia (fuerza garbage collection entre muestras):
//   node --expose-gc scripts/memory-leak-test.js
// Sin ese flag igual corre, solo con más ruido en las lecturas.
const path = require('path');
const db = require(path.join(__dirname, '..', 'db.js'));

const ITERATIONS = 50;
const SAMPLE_EVERY = 10;
const GROWTH_LIMIT_MB = 50;

function heapMb() {
  if (global.gc) global.gc();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

// Cuenta cuántas veces se resuelve/rechaza cada función durante el loop,
// para poder señalar "qué función no libera" si el heap crece de más --
// no hay forma de saber CUÁL de las tres es la responsable solo con la
// lectura total de heap, así que como mínimo se reporta cuál tardó más
// (proxy razonable de "está acumulando trabajo", aunque no es prueba
// definitiva sin un heap snapshot real).
async function callAndTime(fn, label, timings) {
  const t0 = Date.now();
  try {
    await fn();
  } finally {
    timings[label] = (timings[label] || 0) + (Date.now() - t0);
  }
}

async function main() {
  console.log(`Simulando ${ITERATIONS} iteraciones de getAllSales/getAllInventory/getAllRecipesWithStock...\n`);

  const samples = []; // { iter, mb }
  const timings = {};
  let failed = false;

  for (let i = 1; i <= ITERATIONS; i++) {
    await callAndTime(() => db.getAllSales({}), 'getAllSales', timings);
    await callAndTime(() => db.getAllInventory(), 'getAllInventory', timings);
    await callAndTime(() => db.getAllRecipesWithStock(), 'getAllRecipesWithStock', timings);

    if (i % SAMPLE_EVERY === 0) {
      const mb = heapMb();
      samples.push({ iter: i, mb });
      console.log(`  iter ${i}: heapUsed = ${mb.toFixed(1)} MB`);
    }
  }

  console.log('\n--- Resultado ---');

  const first = samples[0]; // iter 10
  const last = samples[samples.length - 1]; // iter 50
  const growth = last.mb - first.mb;

  console.log(`Heap en iter ${first.iter}: ${first.mb.toFixed(1)} MB`);
  console.log(`Heap en iter ${last.iter}: ${last.mb.toFixed(1)} MB`);
  console.log(`Crecimiento: ${growth.toFixed(1)} MB (límite: ${GROWTH_LIMIT_MB} MB)`);

  if (growth > GROWTH_LIMIT_MB) {
    failed = true;
    const slowest = Object.entries(timings).sort((a, b) => b[1] - a[1])[0];
    console.log(`\n\x1b[31mFAIL\x1b[0m: el heap creció ${growth.toFixed(1)} MB entre iter ${first.iter} y ${last.iter}.`);
    console.log(`Función que acumuló más tiempo total (indicio, no prueba directa de cuál filtra): ${slowest[0]} (${slowest[1]}ms acumulados en ${ITERATIONS} llamadas).`);
    console.log('Revisa esa función en db.js primero; si el patrón persiste, correr con --inspect y tomar un heap snapshot en iter 10 y iter 50 para confirmar qué retiene memoria.');
  } else {
    console.log('\n\x1b[32mOK\x1b[0m: sin crecimiento sostenido de heap.');
  }

  console.log('\n--- Chequeo de registro duplicado de IPC handlers (ver detalle debajo) ---');
  const ipcOk = checkNoDuplicateIpcHandlers();
  if (!ipcOk) failed = true;

  process.exit(failed ? 1 : 0);
}

// No se puede probar esto "llamando ipcMain.handle 100 veces" de forma
// realista: ipcMain solo existe de verdad dentro del proceso de Electron
// (bajo `node` normal, require('electron') devuelve la ruta al binario,
// no el módulo -- por eso este archivo corre con `node`, no con
// `electron`, siguiendo lo que pide package.json). El riesgo real que
// describe el patrón #2 de la auditoría de estabilidad es "algo llama
// registerIpcHandlers() más de una vez" (cada llamada repetida a
// ipcMain.handle(canal, ...) para el MISMO canal lanza "Attempted to
// register a second handler"). Eso sí es verificable de forma estática y
// confiable: cuenta cuántas veces aparece cada nombre de canal como
// primer argumento de safeHandle(...) en main.js. Si algún canal aparece
// más de una vez, es exactamente el bug que describe el patrón.
function checkNoDuplicateIpcHandlers() {
  const fs = require('fs');
  const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const channelRegex = /safeHandle\(\s*['"]([^'"]+)['"]/g;
  const seen = new Map();
  let match;
  while ((match = channelRegex.exec(mainJs))) {
    const channel = match[1];
    seen.set(channel, (seen.get(channel) || 0) + 1);
  }
  const dupes = Array.from(seen.entries()).filter(([, count]) => count > 1);
  if (dupes.length > 0) {
    dupes.forEach(([channel, count]) => {
      console.log(`\x1b[31mFAIL\x1b[0m: canal IPC "${channel}" registrado ${count} veces en main.js (ipcMain.handle lanzaría "Attempted to register a second handler").`);
    });
    return false;
  }
  console.log(`\x1b[32mOK\x1b[0m: ${seen.size} canales IPC registrados, ninguno duplicado.`);
  return true;
}

main().catch((err) => {
  console.error('\x1b[31mFAIL\x1b[0m: el test no pudo completarse:', err.message || err);
  process.exit(1);
});
