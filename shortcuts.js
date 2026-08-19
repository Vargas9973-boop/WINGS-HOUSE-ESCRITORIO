// Atajos de teclado del POS -- pensado para operar caja completa sin mouse
// en hora pico. Este archivo es la única fuente de verdad de QUÉ significa
// cada tecla (para que main.js y el modal de ayuda del renderer -- ver
// common.js -- nunca queden desincronizados).
//
// Ojo con el split entre lo que SÍ se registra como atajo de sistema
// (globalShortcut) y lo que NO:
//
//   globalShortcut.register intercepta la combinación en TODO el sistema
//   operativo, para TODAS las aplicaciones, mientras Wings House esté
//   corriendo (aunque esté minimizado). Eso es aceptable para teclas F que
//   casi nadie más usa (F1-F5, F8, F9), pero sería un desastre para
//   Ctrl+P / Ctrl+S / Ctrl+N / Ctrl+K: son atajos universales de imprimir /
//   guardar / nuevo / buscar en CUALQUIER otro programa (navegador, Excel,
//   Notepad...) de la misma PC. Si el negocio usa esa misma computadora para
//   algo más que el POS mientras Wings House sigue abierto, esas
//   combinaciones dejarían de funcionar ahí también, en silencio.
//
//   Por eso Ctrl+P/Ctrl+S/Ctrl+N/Ctrl+K/Alt+C/ESC NO están aquí como
//   globalShortcut: viven como listener local dentro de cada ventana (ver
//   common.js), que solo reacciona cuando esa ventana tiene el foco -- el
//   comportamiento esperado, sin secuestrar el atajo del resto del sistema.
//
// F12 (DevTools) tampoco es global por la misma razón (hijackearía DevTools
// del navegador de cualquier otra ventana) -- se agrega solo como
// accelerator del Menu, y solo fuera de producción (ver main.js).
const SHORTCUTS = [
  { key: 'F1', desc: 'Ver esta ayuda', global: true },
  { key: 'F2', desc: 'Nueva venta (Comandas)', global: true },
  { key: 'F3', desc: 'Ir a Cocina (ventana KDS)', global: true },
  { key: 'F4', desc: 'Ir a Inventario', global: true },
  { key: 'F5', desc: 'Refrescar la pantalla actual', global: true },
  { key: 'F8', desc: 'Mostrar/ocultar TV de cocina (KDS)', global: true },
  { key: 'F9', desc: 'Corte de caja', global: true },
  { key: 'F12', desc: 'DevTools (solo en desarrollo)', global: false },
  { key: 'Ctrl+P', desc: 'Reimprimir el último ticket', global: false },
  { key: 'Ctrl+K', desc: 'Buscar producto (Comandas)', global: false },
  { key: 'Ctrl+N', desc: 'Nueva venta / nuevo insumo, según la pantalla', global: false },
  { key: 'Ctrl+S', desc: 'Guardar el formulario abierto', global: false },
  { key: 'Alt+C', desc: 'Cobrar la venta actual (Comandas)', global: false },
  { key: 'Esc', desc: 'Cerrar el modal abierto / cancelar', global: false }
];

// Páginas a las que puede navegar un atajo de teclado. Copia intencional y
// pequeña del PAGES completo de main.js (no al revés): shortcuts.js no
// puede requerir('./main') sin crear un ciclo (main.js ya requiere este
// archivo), así que solo trae las 3 rutas que de verdad usa un atajo.
const SHORTCUT_PAGES = {
  comandas: 'comandas.html',
  inventory: 'inventory.html',
  corte: 'corte.html'
};

// Despacha un atajo "global" (F1-F5, F8, F9) ya decidido por main.js.
// F3/F8 (ligados a la ventana del KDS) y F8 (toggle) los resuelve el propio
// main.js porque necesitan tocar `kdsWindow`, que vive ahí -- este función
// recibe callbacks para esas dos acciones en vez de la ventana KDS directo,
// para no acoplar este archivo al estado de main.js.
function handleShortcut(key, mainWindow, { openOrFocusKds, toggleKds } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  switch (key) {
    case 'F1':
      mainWindow.webContents.send('shortcut', 'F1');
      break;
    case 'F2':
      mainWindow.loadFile(SHORTCUT_PAGES.comandas).catch((err) => console.error('Atajo F2:', err));
      break;
    case 'F3':
      if (openOrFocusKds) openOrFocusKds();
      break;
    case 'F4':
      mainWindow.loadFile(SHORTCUT_PAGES.inventory).catch((err) => console.error('Atajo F4:', err));
      break;
    case 'F5':
      mainWindow.webContents.send('shortcut', 'F5');
      break;
    case 'F8':
      if (toggleKds) toggleKds();
      break;
    case 'F9':
      mainWindow.loadFile(SHORTCUT_PAGES.corte).catch((err) => console.error('Atajo F9:', err));
      break;
    default:
      // Ctrl+P/Ctrl+S/Ctrl+N/Ctrl+K/Alt+C/ESC no pasan por aquí -- son
      // locales al renderer, ver common.js.
      break;
  }
}

module.exports = { SHORTCUTS, handleShortcut };
