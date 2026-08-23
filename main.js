const { app, BrowserWindow, ipcMain, dialog, Notification, Menu, globalShortcut, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// Sentry se inicializa lo antes posible (antes de cualquier otro require)
// para poder capturar errores incluso durante el arranque. Sin DSN
// configurado (SENTRY_DSN en .env/config.json, ver sentryConfig.js) no
// hace nada -- una instalación sin monitoreo configurado sigue
// funcionando exactamente igual que antes de esto. Cubre el proceso
// PRINCIPAL (main.js/db.js, donde vive casi toda la lógica real); los 5
// procesos de renderer (preload.js, kds/kds-preload.js, report-preload.js,
// history-print-preload.js, ticket-preload.js) se inicializan por su cuenta
// vía sentryConfig.js::initRendererSentry(), mandando sus eventos por IPC a
// este mismo proceso.
const { SENTRY_DSN } = require('./sentryConfig');
if (SENTRY_DSN) {
  const Sentry = require('@sentry/electron/main');
  Sentry.init({
    dsn: SENTRY_DSN,
    tracesSampleRate: 1.0,
    release: `wings-house@${app.getVersion()}`
  });
}

const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
autoUpdater.logger = log;
log.transports.file.level = 'info';

let mainWindow;
let currentSession = null; // { id, username, displayName, role }
const db = require('./db'); // capa de datos sobre Supabase
const attendanceProvider = require('./attendanceProvider'); // lector de huella opcional
const { handleShortcut } = require('./shortcuts'); // atajos de teclado del POS

// ==========================================================================
// KDS (Kitchen Display System) — segunda ventana para la TV de cocina por
// HDMI, ver kds/. Sin login: no pasa por login.html ni por currentSession.
// ==========================================================================
let kdsWindow = null;

// ==========================================================================
// DIAGNÓSTICO DE MEMORIA (solo fuera de producción) -- ver
// scripts/memory-leak-test.js / scripts/stability-test.js (npm run
// test:mem / test:stability) para el chequeo automatizado; esto es el
// mismo dato pero visible en vivo en la consola de `npm start` mientras se
// usa la app de verdad, sin tener que esperar a correr el script aparte.
// ==========================================================================
if (process.env.NODE_ENV !== 'production') {
  setInterval(() => {
    const heapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(`[MEM] heap: ${heapMb}mb`);
  }, 30000);
}

// Config LOCAL (por instalación/PC, no en Supabase): si esta PC en concreto
// tiene la TV de cocina conectada, debe autoarrancar el KDS; otra
// instalación del mismo negocio sin TV no debe. Por eso es un archivo en
// userData y no una fila de la tabla `settings` (esa sí es por negocio).
function getKdsConfigPath() {
  return path.join(app.getPath('userData'), 'kds-config.json');
}

async function readKdsConfig() {
  try {
    return JSON.parse(await fs.promises.readFile(getKdsConfigPath(), 'utf8'));
  } catch (err) {
    return { kdsAutoStart: true }; // primer arranque: no existe el archivo todavía
  }
}

// Sin uso todavía (no hay UI conectada a esto -- ver Ajustes), pero se deja
// async por consistencia con readKdsConfig y para no reintroducir una
// escritura síncrona en el proceso principal el día que se conecte.
async function writeKdsConfig(cfg) {
  try {
    await fs.promises.writeFile(getKdsConfigPath(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    console.error('No se pudo guardar kds-config.json:', err.message);
  }
}

// ==========================================================================
// SUCURSAL — igual que kds-config.json: config LOCAL por instalación (esta
// terminal física vive en un local concreto), no una fila de `settings`.
// Reemplaza el antiguo DEFAULT_BRANCH_ID=1 hardcodeado de db.js -- ver
// Opción A / Tarea 3 del reporte de auditoría multi-sucursal.
// ==========================================================================
function getBranchConfigPath() {
  return path.join(app.getPath('userData'), 'branch-config.json');
}

async function readBranchConfig() {
  try {
    return JSON.parse(await fs.promises.readFile(getBranchConfigPath(), 'utf8'));
  } catch (err) {
    return null; // primer arranque: no existe el archivo todavía
  }
}

async function writeBranchConfig(cfg) {
  await fs.promises.writeFile(getBranchConfigPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

// Resuelve qué sucursal es esta instalación, SIN caer nunca en silencio a
// una constante. Cuatro casos:
//   1. Ya hay branch-config.json -> se usa tal cual.
//   2. No hay config pero en Supabase existe EXACTAMENTE una sucursal ->
//      bootstrap automático (así la instalación que ya está en producción
//      arranca sin pasos manuales la primera vez que corra esta versión).
//   3. No hay config y hay MÁS de una sucursal -> ya no se puede adivinar
//      mirando la lista sola (puede haber varios negocios/tenants, no solo
//      varias sucursales del mismo) -- se devuelve null en vez de tronar:
//      la app arranca igual, muestra el login normal, y auth:login (ver
//      main.js) resuelve la sucursal real del primer login exitoso y la
//      persiste, así que esta función solo se vuelve a necesitar una vez
//      por instalación. Esto es lo que permite vender el mismo .exe
//      genérico a cualquier cliente nuevo sin tocar nada a mano.
//   4. No hay config y hay CERO sucursales -> no hay nada a lo que
//      loguearse todavía (el tenant ni siquiera está dado de alta); esto
//      sí detiene el arranque, es un problema de aprovisionamiento, no de
//      ambigüedad.
async function resolveBranchId() {
  const existing = await readBranchConfig();
  if (existing && existing.branchId) return existing.branchId;

  const branches = await db.getAllBranches();
  if (branches.length === 1) {
    const branchId = branches[0].id;
    await writeBranchConfig({ branchId, branchName: branches[0].name });
    console.log(`Sucursal configurada automáticamente: ${branches[0].name} (id ${branchId}).`);
    return branchId;
  }

  if (branches.length === 0) {
    throw new Error('No hay ninguna sucursal dada de alta en Supabase (tabla branches).');
  }

  console.log(`Hay ${branches.length} sucursales en Supabase -- la sucursal de esta instalación se resolverá con el primer login.`);
  return null;
}

// ==========================================================================
// ALERTA DE COCINA — comandas nuevas por Realtime (ver sección más abajo)
// ==========================================================================
// IDs de "sales" que ESTA instalación acaba de crear (mesa abierta o venta
// de mostrador/llevar). Se usa para no sonar por nuestra propia acción: el
// evento INSERT de Realtime llega también para lo que nosotros insertamos,
// no solo para lo que llega de wings-house-web.
const selfCreatedSaleIds = new Set();
function markSaleSelfCreated(saleId) {
  if (saleId == null) return;
  selfCreatedSaleIds.add(saleId);
  // Ventana amplia: cubre el viaje de ida (insert) y vuelta (evento
  // Realtime) aun con latencia de red alta.
  setTimeout(() => selfCreatedSaleIds.delete(saleId), 10000);
}

// Evita procesar el mismo insert dos veces si Supabase reintenega el evento.
const recentSaleAlertIds = new Map(); // saleId -> timestamp
const ALERT_DEBOUNCE_MS = 3000;

// Único pedido "sonando" a la vez (una sola estación/ventana en esta app).
let activeOrderAlert = null; // { id, tableNumber, clientType, folio, total, startedAt }

// Estado de la conexión Realtime, expuesto al renderer (comandas-renderer.js)
// para que decida si el polling de respaldo debe estar activo o detenido.
let isRealtimeConnected = false;
function broadcastRealtimeStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('order-alert:status', isRealtimeConnected);
  }
  if (kdsWindow && !kdsWindow.isDestroyed()) {
    kdsWindow.webContents.send('kds:online', isRealtimeConnected);
  }
}

// row puede venir de Realtime (viaFallback=false) o del polling de respaldo
// del renderer cuando Realtime está caído (viaFallback=true). En ambos casos
// pasa por el mismo filtro de duplicados.
function handleIncomingSale(row, viaFallback = false) {
  if (!row || row.id == null) return;

  if (row.branch_id != null && row.branch_id !== db.getCurrentBranchId()) return; // otra sucursal

  if (selfCreatedSaleIds.has(row.id)) {
    selfCreatedSaleIds.delete(row.id);
    console.log('🔕 Ignorado duplicado:', row.id);
    return; // lo insertamos nosotros mismos, el mesero/cajero ya lo sabe
  }

  const lastSeen = recentSaleAlertIds.get(row.id);
  if (lastSeen && Date.now() - lastSeen < ALERT_DEBOUNCE_MS) {
    console.log('🔕 Ignorado duplicado:', row.id);
    return;
  }
  recentSaleAlertIds.set(row.id, Date.now());

  console.log('🔔 Nueva comanda recibida: #' + row.id);

  activeOrderAlert = {
    id: row.id,
    tableNumber: row.table_number || null,
    clientType: row.client_type || null,
    folio: row.folio || null,
    total: Number(row.total) || 0,
    startedAt: Date.now()
  };

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.flashFrame(true);
    mainWindow.webContents.send('order-alert:start', activeOrderAlert);
    // Avisa al renderer (comandas-renderer.js) que este ID ya fue notificado
    // por Realtime, para que su polling de respaldo no lo vuelva a reportar.
    if (!viaFallback) mainWindow.webContents.send('order-alert:new-sale', row.id);
  }

  if (Notification.isSupported()) {
    new Notification({
      title: 'Nueva Comanda',
      body: 'Comanda #' + row.id
    }).show();
  }
}

function clearOrderAlert(saleId) {
  if (!activeOrderAlert || activeOrderAlert.id !== saleId) return;
  activeOrderAlert = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.flashFrame(false);
    mainWindow.webContents.send('order-alert:stop', saleId);
  }
}

const PAGES = {
  'open-login': 'login.html',
  'open-menu': 'index.html',
  'open-sales': 'sales.html',
  'open-comandas': 'comandas.html',
  'open-catalog': 'catalog.html',
  'open-inventory': 'inventory.html',
  'open-waste': 'waste.html',
  'open-costs': 'costs.html',
  'open-corte': 'corte.html',
  'open-reports': 'reports.html',
  'open-attendance': 'attendance.html',
  'open-payroll': 'payroll.html',
  'open-history': 'history.html',
  'open-accounts': 'accounts.html',
  'open-settings': 'settings.html'
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0d0100',
    icon: path.join(__dirname, 'build/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile('login.html');
  // mainWindow.webContents.openDevTools(); // Descomentar para depurar
}

// ==========================================================================
// KDS — ventana, refresco y notificación "orden lista" hacia caja
// ==========================================================================
// Recuerda el último kds_status visto por orden para detectar la transición
// exacta a 'lista' (y avisarle a caja una sola vez), no cada refresco.
const lastKdsStatusById = new Map();

function checkKdsReadyTransitions(orders) {
  orders.forEach((o) => {
    const prev = lastKdsStatusById.get(o.id);
    if (prev !== 'lista' && o.kdsStatus === 'lista' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('kds:ready', {
        id: o.id,
        tableNumber: o.tableNumber,
        folio: o.folio,
        clientType: o.clientType
      });
    }
    lastKdsStatusById.set(o.id, o.kdsStatus);
  });
}

async function refreshKdsWindow() {
  if (!kdsWindow || kdsWindow.isDestroyed()) return;
  try {
    const orders = await db.getKdsOrders();
    kdsWindow.webContents.send('kds:orders', orders);
    checkKdsReadyTransitions(orders);
  } catch (err) {
    console.error('No se pudo refrescar el KDS:', err.message);
  }
}

async function pushKdsBranding() {
  if (!kdsWindow || kdsWindow.isDestroyed()) return;
  try {
    const branding = await db.getBranding();
    kdsWindow.webContents.send('kds:branding', branding);
  } catch (err) {
    console.error('No se pudo enviar el branding al KDS:', err.message);
  }
}

// Ícono de la ventana/taskbar: usa el logo subido en Ajustes si existe, si
// no se queda con build/icon.ico (el que ya trae setIcon() en la creación
// de la ventana). Best-effort -- si falla la descarga o el formato no es
// válido, no rompe nada más, solo se queda con el ícono que ya había.
async function refreshAppIcon() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const branding = await db.getBranding();
    if (!branding.logoUrl) return;
    const https = require('https');
    const buffer = await new Promise((resolve, reject) => {
      https.get(branding.logoUrl, (res) => {
        if (res.statusCode !== 200) { reject(new Error(`status ${res.statusCode}`)); return; }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
    const img = nativeImage.createFromBuffer(buffer);
    if (img.isEmpty()) return;
    mainWindow.setIcon(img);
  } catch (err) {
    console.error('No se pudo actualizar el ícono de la app:', err.message);
  }
}

// Respaldo de polling para el KDS "sin login" (ver comentario en db.js
// línea ~1417): supabase.subscribeToKdsChanges() usa Realtime sobre
// `sales`, y Realtime respeta RLS -- desde
// 20260822120000_rls_restrictive_phase1.sql, `sales` solo es visible para
// `authenticated`, así que si nadie inició sesión en la ventana principal
// (mismo proceso, mismo cliente de Supabase compartido) el canal de
// Realtime deja de recibir eventos para este KDS y se queda congelado sin
// este respaldo. Si SÍ hay sesión (alguien logueado en la ventana
// principal), Realtime sigue dando el refresco instantáneo de siempre --
// esto es solo una red de seguridad, no un reemplazo.
let kdsPollInterval = null;

function startKdsPolling() {
  stopKdsPolling();
  kdsPollInterval = setInterval(refreshKdsWindow, 15000);
}

function stopKdsPolling() {
  if (kdsPollInterval) {
    clearInterval(kdsPollInterval);
    kdsPollInterval = null;
  }
}

// Crea (o enfoca, si ya existe) la ventana de la TV de cocina. `screen` se
// requiere aquí adentro -- nunca al inicio del archivo -- porque la API de
// pantallas de Electron solo es válida después de que la app está 'ready';
// esta función nunca se llama antes (menú, atajo F8 y autoarranque corren
// todos dentro/después de app.whenReady()).
function createKDSWindow() {
  if (kdsWindow && !kdsWindow.isDestroyed()) {
    kdsWindow.focus();
    return kdsWindow;
  }

  const { screen } = require('electron');
  const displays = screen.getAllDisplays();
  const target = displays[1] || displays[0];
  const isSecondScreen = displays.length > 1;

  kdsWindow = new BrowserWindow({
    x: target.bounds.x + 20,
    y: target.bounds.y + 20,
    width: isSecondScreen ? target.bounds.width : 1280,
    height: isSecondScreen ? target.bounds.height : 720,
    fullscreen: isSecondScreen,
    fullscreenable: true,
    autoHideMenuBar: true,
    alwaysOnTop: false,
    kiosk: false,
    title: 'KDS COCINA',
    backgroundColor: '#111111',
    icon: path.join(__dirname, 'build/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'kds', 'kds-preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  kdsWindow.setMenuBarVisibility(false);
  kdsWindow.loadFile('kds/kds.html');
  kdsWindow.webContents.on('did-finish-load', () => {
    refreshKdsWindow();
    pushKdsBranding();
    kdsWindow.webContents.send('kds:online', isRealtimeConnected);
  });
  startKdsPolling();
  kdsWindow.on('closed', () => { kdsWindow = null; stopKdsPolling(); });

  return kdsWindow;
}

// Reubica el KDS ya abierto en la segunda pantalla (útil si la TV se conectó
// después de abrir el KDS en la pantalla principal). Si no hay una segunda
// pantalla conectada, avisa en vez de mover la ventana a ciegas.
function moveKdsToSecondDisplay() {
  const { screen } = require('electron');
  const displays = screen.getAllDisplays();
  if (displays.length < 2) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'KDS',
      message: 'No se detecta una segunda pantalla/TV conectada.'
    });
    return;
  }
  if (!kdsWindow || kdsWindow.isDestroyed()) {
    createKDSWindow();
    return;
  }
  const target = displays[1];
  kdsWindow.setFullScreen(false);
  kdsWindow.setBounds({ x: target.bounds.x, y: target.bounds.y, width: target.bounds.width, height: target.bounds.height });
  kdsWindow.setFullScreen(true);
  kdsWindow.focus();
}

// Abre la ventana del KDS si está cerrada, o la enfoca si ya está abierta
// (F3: "ir a cocina", nunca la cierra). Distinto de toggleKdsWindow (F8):
// F3 siempre te deja viéndola, F8 la prende/apaga.
function openOrFocusKdsWindow() {
  if (kdsWindow && !kdsWindow.isDestroyed()) {
    kdsWindow.focus();
    return;
  }
  createKDSWindow();
}

// F8: enciende/apaga la TV de cocina con la misma tecla (antes solo la
// abría -- si ya estaba abierta, F8 no hacía nada más que enfocarla).
function toggleKdsWindow() {
  if (kdsWindow && !kdsWindow.isDestroyed()) {
    kdsWindow.close();
  } else {
    createKDSWindow();
  }
}

// Único punto de entrada para las 7 teclas globales (F1,F2,F4,F5,F9 navegan
// vía shortcuts.js; F3/F8 tocan la ventana del KDS, que vive aquí en
// main.js, así que se le pasan como callbacks en vez de duplicar el estado
// de kdsWindow dentro de shortcuts.js). Tanto el Menu como
// registerGlobalShortcuts llaman esto mismo -- si algún día se disparan
// los dos para la misma tecla (Menu accelerator + globalShortcut), lo peor
// que pasa es navegar/refrescar/togglear dos veces seguidas, que es
// inofensivo para estas acciones (no así para cobrar una venta, por eso
// Alt+C NO es un atajo global -- ver common.js).
function dispatchShortcut(key) {
  handleShortcut(key, mainWindow, {
    openOrFocusKds: openOrFocusKdsWindow,
    toggleKds: toggleKdsWindow
  });
}

function buildAppMenu() {
  const isDev = !app.isPackaged;
  const template = [
    {
      label: 'Ver',
      submenu: [
        { label: 'Ayuda de atajos (F1)', accelerator: 'F1', click: () => dispatchShortcut('F1') },
        { label: 'Nueva venta / Comandas (F2)', accelerator: 'F2', click: () => dispatchShortcut('F2') },
        { label: 'Ir a Cocina / KDS (F3)', accelerator: 'F3', click: () => dispatchShortcut('F3') },
        { label: 'Inventario (F4)', accelerator: 'F4', click: () => dispatchShortcut('F4') },
        { label: 'Refrescar (F5)', accelerator: 'F5', click: () => dispatchShortcut('F5') },
        { type: 'separator' },
        { label: 'Mostrar/ocultar TV de cocina (F8)', accelerator: 'F8', click: () => dispatchShortcut('F8') },
        // F9 antes movía el KDS a la segunda pantalla; ahora F9 es "Corte de
        // caja" (pedido explícito, más usado en hora pico que reacomodar la
        // TV). Esa acción sigue disponible por mouse aquí, solo sin atajo.
        { label: 'Mover KDS a segunda pantalla', click: () => moveKdsToSecondDisplay() },
        { label: 'Cerrar KDS', click: () => { if (kdsWindow && !kdsWindow.isDestroyed()) kdsWindow.close(); } },
        { type: 'separator' },
        { label: 'Corte de caja (F9)', accelerator: 'F9', click: () => dispatchShortcut('F9') },
        ...(isDev ? [
          { type: 'separator' },
          {
            label: 'DevTools (F12)',
            accelerator: 'F12',
            click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.toggleDevTools(); }
          }
        ] : [])
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Atajos de SISTEMA (funcionan aunque la ventana no tenga el foco, ver
// shortcuts.js para la razón de por qué solo estas 7 teclas y no
// Ctrl+P/Ctrl+S/Ctrl+N/Ctrl+K/Alt+C/ESC). Se registran una sola vez en
// whenReady() y se liberan en will-quit -- si algún día esto se llamara dos
// veces por error, globalShortcut.register no truena (simplemente
// reemplaza el registro anterior para esa tecla), así que no hay riesgo de
// "already registered" como con ipcMain.handle.
function registerGlobalShortcuts() {
  ['F1', 'F2', 'F3', 'F4', 'F5', 'F8', 'F9'].forEach((accelerator) => {
    const registered = globalShortcut.register(accelerator, () => dispatchShortcut(accelerator));
    if (!registered) console.warn(`No se pudo registrar el atajo global ${accelerator} (¿ya lo usa otra app?).`);
  });
}

app.whenReady().then(async () => {
  try {
    const branchId = await resolveBranchId();
    if (branchId) {
      db.setCurrentBranchId(branchId);
      // Secreto de KDS (ver 20260822190000_kds_secret_hotfix.sql): mismo
      // archivo que branchId, campo opcional -- instalaciones sin TV de
      // cocina sin login no lo necesitan.
      const branchConfig = await readBranchConfig();
      db.setCurrentKdsSecret(branchConfig && branchConfig.kdsSecret);
    }
    // branchId null (más de una sucursal en Supabase, instalación nueva sin
    // config todavía) NO es un error -- se sigue arrancando igual, y
    // auth:login (más abajo) termina de resolverlo con el primer login real.
  } catch (err) {
    console.error('No se pudo resolver la sucursal de esta instalación:', err.message);
    dialog.showErrorBox(
      'No se pudo determinar la sucursal',
      `${err.message}\n\nLa aplicación no puede continuar sin esto (evita vender/cobrar en la sucursal equivocada).`
    );
    app.quit();
    return;
  }

  try {
    await db.init(); // siembra las cuentas por defecto en Supabase si hace falta
  } catch (err) {
    console.error('Error al inicializar Supabase:', err);
  }
  // Ambas dependen de saber ya la sucursal (arman su filtro de Realtime con
  // getCurrentBranchId(), que truena si no está configurada) -- si esta
  // instalación todavía no la sabe (ver arriba), auth:login las arranca en
  // cuanto el primer login la resuelva.
  if (db.getCurrentBranchIdOrNull()) {
    db.subscribeToNewSales(handleIncomingSale, (connected) => {
      isRealtimeConnected = connected;
      broadcastRealtimeStatus();
    });
    db.subscribeToKdsChanges(() => refreshKdsWindow());
  }
  registerIpcHandlers();
  createWindow();
  buildAppMenu();
  registerGlobalShortcuts();
  // best-effort, no bloquea el arranque si falla -- necesita saber ya la
  // sucursal (db.getBranding() usa getCurrentBranchId()), así que se salta
  // si todavía no se resolvió (ver guardas de arriba); se refresca sola
  // después vía settings:refreshBranding tras el primer login.
  if (db.getCurrentBranchIdOrNull()) refreshAppIcon();

  // Autoarranque del KDS en la TV: solo si esta PC lo tiene configurado
  // (kds-config.json, por defecto true), de verdad hay una segunda
  // pantalla conectada, y ya se sabe la sucursal (si no, se abre sola en
  // el siguiente arranque normal, una vez que el primer login la resuelva).
  const { screen } = require('electron');
  const kdsConfig = await readKdsConfig();
  if (db.getCurrentBranchIdOrNull() && kdsConfig.kdsAutoStart === true && screen.getAllDisplays().length > 1) {
    createKDSWindow();
  }

  autoUpdater.checkForUpdatesAndNotify();

  autoUpdater.on('update-available', () => log.info('Update available'));
  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Actualización lista',
      message: 'Nueva versión descargada. ¿Reiniciar ahora para instalar?',
      buttons: ['Reiniciar ahora', 'Después']
    }).then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(); });
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Sin esto, los 7 atajos globales (F1,F2,F3,F4,F5,F8,F9) se quedan
// registrados a nivel de SISTEMA OPERATIVO incluso después de cerrar Wings
// House -- globalShortcut no se libera solo al cerrar la app.
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ==========================================================================
// NAVEGACIÓN ENTRE MÓDULOS
// ==========================================================================
ipcMain.on('send-action', (event, action) => {
  const page = PAGES[action];
  if (page) {
    mainWindow.loadFile(page).catch((err) => console.error(`Error al cargar ${page}:`, err));
  } else {
    console.log(`Acción desconocida: ${action}`);
  }
});

// ==========================================================================
// UTILIDADES
// ==========================================================================
function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n;]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  rows.forEach((row) => lines.push(row.map(csvEscape).join(',')));
  return '\uFEFF' + lines.join('\r\n'); // BOM para que Excel abra bien los acentos
}

// Sin esto, un fn() colgado (WiFi del negocio se cae a medias, DNS no
// resuelve, lo que sea) nunca resuelve ni rechaza: supabase-js no trae
// timeout por defecto en supabaseClient.js, así que el fetch se queda
// esperando indefinidamente. Eso significa que el `await
// window.db.inventory.create(...)` del renderer (p.ej.
// inventory-renderer.js saveItem()) nunca vuelve, el botón "Guardar" se
// queda disabled para siempre y no aparece ningún error -- desde el punto
// de vista del usuario, la app se "congeló". Este era el único canal de
// IPC del proyecto sin ese resguardo (imprimir ticket/reporte/historial ya
// lo tenían, ver printFullReport/printHistoryReport/printTicket).
// No cancela el fetch de verdad (supabase-js no expone AbortController
// aquí) -- solo deja de esperarlo y le devuelve un error claro al
// renderer para que el botón se reactive y el usuario pueda reintentar.
const IPC_TIMEOUT_MS = 20000;

function withTimeout(promise) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Tiempo de espera agotado. Revisa tu conexión a internet e intenta de nuevo.'));
    }, IPC_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function safeHandle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await withTimeout(fn(...args)) };
    } catch (err) {
      console.error(`Error en ${channel}:`, err);
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function money(n) {
  return (Number(n) || 0).toFixed(2);
}

const HISTORY_TIPO_LABELS = {
  venta: 'Venta',
  para_llevar: 'Para Llevar',
  domicilio: 'Domicilio',
  beneficio_empleado: 'Beneficio Empleado',
  consumo_interno: 'Consumo Jefes',
  merma: 'Merma'
};

function registerIpcHandlers() {
  function requireAdmin() {
    if (!currentSession || currentSession.role !== 'admin') {
      throw new Error('Se requiere una cuenta de administrador para esta acción.');
    }
  }

  // Reemplazo gradual de requireAdmin(): 'admin' (texto legado) siempre
  // pasa, sin importar permissions (nunca debe poder quedar fuera de su
  // propia app); para el resto, revisa el arreglo de permisos que login()
  // ya adjuntó a la sesión (get_user_permissions). Si el usuario no tiene
  // role_id todavía (instalación sin migrar), permissions viene vacío y
  // esto deniega -- mismo criterio conservador que requireAdmin() ya tenía
  // para cualquiera que no fuera 'admin'.
  function requirePermission(moduleName, action) {
    if (!currentSession) throw new Error('No hay sesión activa.');
    if (currentSession.role === 'admin') return;
    const perms = currentSession.permissions || [];
    const modPerm = perms.find((p) => p.module === moduleName);
    if (!modPerm || !modPerm[action]) {
      throw new Error('No tienes permiso para realizar esta acción.');
    }
  }

  // ------------------------------------------------------------------
  // AUTENTICACIÓN Y CUENTAS
  // ------------------------------------------------------------------
  safeHandle('auth:login', async (username, password) => {
    const session = await db.login(username, password);
    currentSession = session;

    // Instalación nueva cuyo branch-config.json no traía branchId todavía
    // (ver resolveBranchId()/app.whenReady() -- pasa cuando ya hay más de
    // una sucursal en Supabase y no se podía adivinar cuál le tocaba a esta
    // instalación). Ahora sí se sabe con certeza: viene del login real
    // (session.branchId, la Edge Function lo lee de users.branch_id), no de
    // una lista adivinada. Se fija y se persiste para que el próximo
    // arranque ya no dependa de loguearse primero, y se arrancan las
    // suscripciones Realtime que se saltaron en el arranque por no saber
    // todavía a qué sucursal filtrar.
    if (!db.getCurrentBranchIdOrNull() && session.branchId) {
      db.setCurrentBranchId(session.branchId);
      try {
        const cfg = (await readBranchConfig()) || {};
        const branches = await db.getAllBranches();
        const branch = branches.find((b) => b.id === session.branchId);
        await writeBranchConfig({ ...cfg, branchId: session.branchId, branchName: branch ? branch.name : undefined });
      } catch (err) {
        console.error('No se pudo persistir la sucursal resuelta por el login:', err.message);
      }
      db.subscribeToNewSales(handleIncomingSale, (connected) => {
        isRealtimeConnected = connected;
        broadcastRealtimeStatus();
      });
      db.subscribeToKdsChanges(() => refreshKdsWindow());
    }

    // Onboarding del secreto de KDS (ver 20260822190000_kds_secret_hotfix.sql
    // y db.js::fetchBranchKdsSecret): ya hay sesión real de Supabase Auth
    // (db.login() la estableció arriba), así que si branch-config.json
    // todavía no tiene kdsSecret, se autocompleta aquí -- ya no hace falta
    // el paso manual documentado antes. No bloquea el login si falla (KDS
    // sin login es una feature opcional, no algo de lo que dependa vender).
    try {
      const cfg = (await readBranchConfig()) || {};
      if (!cfg.kdsSecret) {
        const secret = await db.fetchBranchKdsSecret(db.getCurrentBranchId());
        if (secret) {
          await writeBranchConfig({ ...cfg, kdsSecret: secret });
          db.setCurrentKdsSecret(secret);
        }
      }
    } catch (err) {
      console.error('No se pudo autocompletar el secreto de KDS:', err.message);
    }

    return currentSession;
  });

  safeHandle('auth:logout', async () => {
    currentSession = null;
    await db.logout();
    return true;
  });

  safeHandle('auth:getSession', () => currentSession);

  safeHandle('auth:changePassword', async (userId, newPassword) => {
    if (!currentSession) throw new Error('No hay sesión activa.');
    if (currentSession.role !== 'admin' && currentSession.id !== userId) {
      throw new Error('No puedes cambiar la contraseña de otra cuenta.');
    }
    return db.changePassword(userId, newPassword);
  });

  safeHandle('users:getAll', () => {
    requirePermission('cuentas', 'can_view');
    return db.getAllUsers();
  });

  safeHandle('users:create', (data) => {
    requirePermission('cuentas', 'can_create');
    return db.createUser(data);
  });

  safeHandle('users:update', (id, data) => {
    requirePermission('cuentas', 'can_edit');
    return db.updateUser(id, data);
  });

  safeHandle('users:remove', (id) => {
    requirePermission('cuentas', 'can_delete');
    if (currentSession.id === id) throw new Error('No puedes eliminar la cuenta con la que iniciaste sesión.');
    return db.removeUser(id);
  });

  // ------------------------------------------------------------------
  // ROLES Y PERMISOS (Cuentas -> "Permisos por rol")
  // ------------------------------------------------------------------
  safeHandle('roles:getAll', () => {
    requirePermission('cuentas', 'can_view');
    return db.getRoles();
  });
  safeHandle('roles:create', (data) => {
    requirePermission('cuentas', 'can_create');
    return db.createRole(data);
  });
  safeHandle('roles:update', (id, data) => {
    requirePermission('cuentas', 'can_edit');
    return db.updateRole(id, data);
  });
  safeHandle('roles:remove', (id) => {
    requirePermission('cuentas', 'can_delete');
    return db.removeRole(id);
  });
  safeHandle('roles:getPermissions', (roleId) => {
    requirePermission('cuentas', 'can_view');
    return db.getRolePermissions(roleId);
  });
  safeHandle('roles:setPermissions', (roleId, permissions) => {
    requirePermission('cuentas', 'can_edit');
    return db.setRolePermissions(roleId, permissions);
  });

  // ------------------------------------------------------------------
  // PRODUCTOS (Catálogo)
  // ------------------------------------------------------------------
  safeHandle('products:getAll', () => db.getAllProducts());
  safeHandle('products:create', (data) => db.createProduct(data));
  safeHandle('products:update', (id, data) => db.updateProduct(id, data));
  safeHandle('products:adjustStock', (id, delta) => db.adjustProductStock(id, delta));
  safeHandle('products:remove', (id) => db.removeProduct(id));
  // Re-ejecuta manualmente la migración de categorías Alitas/Boneless (idempotente).
  // Se corre automáticamente en cada arranque desde db.init(); este handler
  // solo sirve para forzarla sin reiniciar la app tras editar datos a mano.
  safeHandle('products:migrateCategories', () => {
    requireAdmin();
    return db.migrateAlitasBonelessCategories();
  });

  // ------------------------------------------------------------------
  // PROMOCIONES (usadas en el módulo de Ventas)
  // ------------------------------------------------------------------
  safeHandle('promotions:getAll', () => db.getAllPromotions());
  safeHandle('promotions:create', (data) => db.createPromotion(data));
  safeHandle('promotions:update', (id, data) => db.updatePromotion(id, data));
  safeHandle('promotions:remove', (id) => db.removePromotion(id));

  // ------------------------------------------------------------------
  // VENTAS
  // ------------------------------------------------------------------
  safeHandle('sales:create', async (payload) => {
    const sale = await db.createSale(payload, currentSession ? currentSession.username : null, currentSession ? currentSession.id : null);
    markSaleSelfCreated(sale.id);
    return sale;
  });
  safeHandle('sales:getById', (id) => db.getSaleById(id));
  safeHandle('sales:getAll', (filters = {}) => db.getAllSales(filters));
  safeHandle('sales:markPrinted', (id) => db.markSalePrinted(id));
  safeHandle(
  'employee:getDailyConsumption',
  (employeeId) => db.getEmployeeDailyConsumption(employeeId)
);

  // ------------------------------------------------------------------
  // ALERTA DE COCINA (comandas nuevas por Realtime)
  // ------------------------------------------------------------------
  safeHandle('order-alert:getActive', () => activeOrderAlert);
  safeHandle('order-alert:getStatus', () => isRealtimeConnected);
  ipcMain.on('order-alert:dismiss', (event, saleId) => clearOrderAlert(saleId));
  // Reportado por el polling de respaldo de comandas-renderer.js cuando
  // Realtime está caído; reusa el mismo filtro de duplicados de arriba.
  ipcMain.on('order-alert:fallback-sale', (event, row) => handleIncomingSale(row, true));

  // ------------------------------------------------------------------
  // KDS (pantalla de cocina — segunda ventana/TV, ver kds/)
  // ------------------------------------------------------------------
  safeHandle('kds:updateStatus', async (saleId, status) => {
    await db.updateKdsStatus(saleId, status);
    // No espera al viaje de ida y vuelta de Realtime para reflejarlo: quien
    // tocó el botón en la TV ve el cambio de inmediato.
    await refreshKdsWindow();
    return true;
  });

  // Esc en el KDS (ver kds-renderer.js): la ventana está en fullscreen
  // nativo de Electron, no del DOM, así que solo el proceso principal puede
  // quitarlo.
  ipcMain.on('kds:exit-fullscreen', () => {
    if (kdsWindow && !kdsWindow.isDestroyed()) kdsWindow.setFullScreen(false);
  });

  // ------------------------------------------------------------------
  // COMANDAS (control de consumo por mesa)
  // ------------------------------------------------------------------
  safeHandle('comandas:getTables', () => db.getTables());
  safeHandle('comandas:openTable', async (tableNumber) => {
    const opened = await db.openTable(tableNumber, currentSession ? currentSession.username : null);
    markSaleSelfCreated(opened.id);
    return opened;
  });
  safeHandle('comandas:getOpenSale', (tableNumber) => db.getOpenSaleByTable(tableNumber));
  safeHandle('comandas:getTakeoutOrders', () => db.getOpenTakeoutOrders());
  safeHandle('comandas:setDeliveryStatus', (saleId, status) => db.comandaSetDeliveryStatus(saleId, status));
  safeHandle('comandas:openTakeout', async () => {
    const opened = await db.openTakeoutOrder(currentSession ? currentSession.username : null);
    markSaleSelfCreated(opened.id);
    return opened;
  });
  safeHandle('comandas:getOpenSaleById', (saleId) => db.getOpenSaleById(saleId));
  safeHandle('comandas:addItem', (saleId, item) => db.comandaAddItem(saleId, item));
  safeHandle('comandas:updateItemQty', (itemId, quantity) => db.comandaUpdateItemQty(itemId, quantity));
  safeHandle('comandas:removeItem', (itemId) => db.comandaRemoveItem(itemId));
  safeHandle('comandas:closeTable', (saleId, payload) =>
    db.comandaCloseTable(saleId, payload, currentSession ? currentSession.username : null, currentSession ? currentSession.id : null));
  safeHandle('comandas:cancelTable', (saleId) => db.comandaCancelTable(saleId));
  safeHandle('comandas:assignDriver', (saleId, driverId, deliveryFee) => db.comandaAssignDriver(saleId, driverId, deliveryFee));

  // ------------------------------------------------------------------
  // MODIFICADORES (salsas) -- ver product_modifier_groups / sale_item_modifiers
  // ------------------------------------------------------------------
  safeHandle('modifiers:list', (groupName) => db.getModifiers(groupName));
  safeHandle('modifiers:update', (id, data) => db.updateModifier(id, data));
  safeHandle('productModifierGroups:getAll', () => db.getAllProductModifierGroups());
  safeHandle('productModifierGroups:set', (productId, groupName, enabled, qty) => db.setProductModifierGroup(productId, groupName, enabled, qty));

  // ------------------------------------------------------------------
  // COMBOS -- ver product_components (producto -> producto)
  // ------------------------------------------------------------------
  safeHandle('productComponents:getForProduct', (productId) => db.getComponentsForProduct(productId));
  safeHandle('productComponents:setForProduct', (productId, rows) => db.setComponentsForProduct(productId, rows));
  safeHandle('productComponents:getAll', () => db.getAllProductComponents());

  // ------------------------------------------------------------------
  // REPARTIDORES / LIQUIDACIÓN DE DINERO EN CALLE
  // ------------------------------------------------------------------
  safeHandle('drivers:getAll', () => db.getDrivers());
  safeHandle('drivers:create', (name, phone) => db.createDriver(name, phone));
  safeHandle('drivers:getPendingMoney', () => db.getPendingDriverMoney());
  safeHandle('drivers:liquidate', (driverId) => db.liquidateDriverSales(driverId));
  safeHandle('drivers:getSalesByPaymentStatus', (status) => db.getSalesByPaymentStatus(status));

  // ------------------------------------------------------------------
  // INVENTARIOS
  // ------------------------------------------------------------------
  safeHandle('inventory:getAll', () => db.getAllInventory());
  safeHandle('inventory:create', (data) =>
    db.createInventoryItem(data, currentSession ? currentSession.username : null));
  safeHandle('inventory:update', (id, data) =>
    db.updateInventoryItem(id, data, currentSession ? currentSession.username : null));
  safeHandle('inventory:remove', (id) => db.removeInventoryItem(id));
  safeHandle('inventory:addStock', (id, data) =>
    db.addInventoryStock(id, data, currentSession ? currentSession.username : null));
  safeHandle('inventory:getMovements', (id) => db.getInventoryMovements(id));
  safeHandle('inventory:checkLowStock', () => db.checkLowStockInventory());

  // ------------------------------------------------------------------
  // RECETAS (producto -> insumos que consume)
  // ------------------------------------------------------------------
  safeHandle('recipes:getForProduct', (productId) => db.getRecipesForProduct(productId));
  safeHandle('recipes:setForProduct', (productId, rows) => db.setRecipesForProduct(productId, rows));
  safeHandle('recipes:getCost', (productId) => db.getRecipeCost(productId));
  safeHandle('recipes:getProductIdsWithRecipe', () => db.getProductIdsWithRecipe());
  safeHandle('recipes:getAllCosts', () => db.getAllRecipeCosts());
  safeHandle('recipes:getAllWithStock', () => db.getAllRecipesWithStock());

  // ------------------------------------------------------------------
  // MERMA
  // ------------------------------------------------------------------
  safeHandle('waste:getAll', (filters = {}) => db.getAllWaste(filters));
  safeHandle('waste:create', (data) => db.createWaste(data));

  // ------------------------------------------------------------------
  // COSTOS
  // ------------------------------------------------------------------
  safeHandle('costs:getAll', (filters = {}) => db.getAllCosts(filters));
  safeHandle('costs:create', (data) => db.createCost(data));
  safeHandle('costs:remove', (id) => db.removeCost(id));

    // ------------------------------------------------------------------
  // CORTE DE CAJA
  // ------------------------------------------------------------------
  safeHandle('corte:getResumen', (fecha) => db.getCorteResumen(fecha));
  safeHandle('corte:setFondoInicial', (fecha, fondoInicial) => db.setCashCutFondoInicial(fecha, fondoInicial));
  safeHandle('corte:addMovimiento', (data) => db.createCashMovement(data));
  safeHandle('corte:removeMovimiento', (id) => db.removeCashMovement(id));
  safeHandle('corte:cerrar', (fecha, efectivoReal) =>
    db.closeCashCut(fecha, efectivoReal, currentSession ? currentSession.username : null));
  safeHandle('corte:getByFecha', (fecha) => db.getCorteByFecha(fecha));

  safeHandle('corte:printTicket', async (html) => {
    const settings = await db.getAllSettings();
    if (!isPrinterEnabled(settings)) {
      console.log('🖨️ Impresión deshabilitada en Ajustes. Se omite (corte).');
      return { success: false, reason: 'disabled' };
    }
    const win = new BrowserWindow({ show: false, width: 302, height: 800, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise(r => setTimeout(r, 800));
    win.webContents.print({ silent: false, printBackground: true, pageSize: getThermalPageSize(settings.ticket_width) }, () => {
      setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 1000);
    });
    return true;
  });

  safeHandle('reports:profitability', (filters = {}) =>
    db.computeProfitability(filters.dateFrom || '2000-01-01', filters.dateTo || '2999-12-31'));
  safeHandle('reports:cortes', (f = {}) =>
    db.getCashCutsHistory(f.dateFrom || '2000-01-01', f.dateTo || '2999-12-31'));

  // ------------------------------------------------------------------
  // EMPLEADOS Y ASISTENCIA
  // ------------------------------------------------------------------
  safeHandle('employees:getAll', () => db.getAllEmployees());
  safeHandle('employees:create', (data) => db.createEmployee(data));
  safeHandle('employees:update', (id, data) => db.updateEmployee(id, data));
  safeHandle('employees:remove', (id) => db.removeEmployee(id));

  safeHandle('attendance:getToday', () => db.getTodayAttendance());
  safeHandle('attendance:getAll', (filters = {}) => db.getAllAttendance(filters));
  safeHandle('attendance:register', (employeeId) => db.registerAttendance(employeeId));

  // ------------------------------------------------------------------
  // BIOMETRÍA (lector de huella opcional; ver attendanceProvider.js)
  // ------------------------------------------------------------------
  safeHandle('biometric:getSettings', () => db.getBiometricSettings());

  // Sondeo de hardware: intenta detectar el lector por HID. Nunca rechaza
  // la promesa -- si algo falla (SDK no instalado, sin permisos, sin
  // lector), resuelve {connected:false} para que el renderer no necesite
  // manejar un error especial y el modo manual siga siendo el camino feliz.
  safeHandle('biometric-scan', async (model) => {
    try {
      const settings = model ? { model } : await db.getBiometricSettings();
      const device = attendanceProvider.findConnectedDevice(settings.model);
      if (!device) return { connected: false };
      return {
        connected: true,
        model: settings.model,
        deviceInfo: {
          vendorId: device.vendorId,
          productId: device.productId,
          product: device.product || null,
          manufacturer: device.manufacturer || null
        }
      };
    } catch (err) {
      console.warn('[biometric-scan] fallo al sondear el lector:', err.message);
      return { connected: false };
    }
  });

  safeHandle('biometric:enroll', async (employeeId) => {
    const settings = await db.getBiometricSettings();
    const provider = attendanceProvider.getAttendanceProvider(db, settings);
    // Cuando el SDK del fabricante esté integrado, enrollFingerprint()
    // devolverá la plantilla capturada y aquí se persiste; hoy siempre
    // rechaza con un mensaje claro (ver attendanceProvider.js).
    const template = await provider.enrollFingerprint(employeeId);
    await db.saveFingerprint(employeeId, template);
    return { enrolled: true };
  });

  safeHandle('biometric:identify', async () => {
    const settings = await db.getBiometricSettings();
    const provider = attendanceProvider.getAttendanceProvider(db, settings);
    return provider.identify();
  });

  // ------------------------------------------------------------------
  // NÓMINA SEMANAL (salario + bono acreditable por semana)
  // ------------------------------------------------------------------
  safeHandle('payroll:getWeek', (weekStart) => db.getPayrollWeek(weekStart));
  safeHandle('payroll:setBonus', (payload) => db.setPayrollBonus(payload));
  safeHandle('payroll:history', (filters = {}) => db.getPayrollHistory(filters));
  safeHandle('payroll:pendientes', (weekStart) => db.getPayrollDeductionsPendientes(weekStart));

  // ------------------------------------------------------------------
  // NÓMINA CONFIGURABLE (día de pago, faltas, cierre semanal)
  // ------------------------------------------------------------------
  safeHandle('payroll:getSettings', () => db.getPayrollSettings());
  safeHandle('payroll:getWeekRange', (paydayNumber, referenceDate) => db.getWeekRange(paydayNumber, referenceDate));
  safeHandle('payroll:getData', (weekStart, weekEnd) => db.getPayrollData(weekStart, weekEnd));
  safeHandle('payroll:saveBono', (employeeId, weekEnd, acredita) => db.saveBonoAcreditacion(employeeId, weekEnd, acredita));
  safeHandle('payroll:getDetail', (employeeName, weekStart, weekEnd) => db.getPayrollDetail(employeeName, weekStart, weekEnd));
  safeHandle('payroll:close', (weekStart, weekEnd) =>
    db.closePayrollWeek(weekStart, weekEnd, currentSession ? currentSession.username : null));

  // ------------------------------------------------------------------
  // AJUSTES
  // ------------------------------------------------------------------
  safeHandle('settings:getAll', () => db.getAllSettings());
  safeHandle('settings:set', (key, value) => db.setSetting(key, value));
  safeHandle('settings:uploadLogo', (filePath, fileName) => db.uploadLogo(filePath, fileName));
  // Llamado por settings-renderer.js justo después de guardar/subir logo,
  // igual que ya hace con window.loadAndApplyBranding() para el resto de la
  // app -- el KDS no tiene Supabase propio (ver comentario "sin login" en
  // este mismo archivo), así que su branding solo puede llegar empujada
  // por IPC desde aquí.
  safeHandle('settings:refreshBranding', async () => {
    await pushKdsBranding();
    await refreshAppIcon();
    return true;
  });

  // ------------------------------------------------------------------
  // EXPORTACIÓN DE REPORTES (CSV y reporte imprimible)
  // ------------------------------------------------------------------
  safeHandle('export:csv', async (type, dateFrom, dateTo) => {
    let headers = [];
    let rows = [];
    const defaultName = `reporte_${type}_sucursal${db.getCurrentBranchId()}_${dateFrom}_a_${dateTo}.csv`;

    if (type === 'ventas') {
      headers = ['Folio', 'Fecha', 'Mesa', 'Cliente', 'Subtotal', 'Descuento', 'Total', 'Pago', 'Cajero'];
      const sales = await db.getAllSales({ status: 'completada', dateFrom, dateTo });
      rows = sales.map((s) => [
        s.folio, s.created_at, s.table_number || '', s.client_type, money(s.subtotal), money(s.discount), money(s.total), s.payment_method, s.opened_by || ''
      ]);
    } else if (type === 'productos') {
      headers = ['Producto', 'Unidades vendidas', 'Total vendido'];
      const summary = await db.getProductsSummary(dateFrom, dateTo);
      rows = summary.map((r) => [r.name, r.unidades, money(r.total)]);
    } else if (type === 'gastos') {
      headers = ['Fecha', 'Concepto', 'Categoría', 'Monto'];
      const costs = await db.getAllCosts({ dateFrom, dateTo });
      rows = costs.map((c) => [c.date, c.concept, c.category, money(c.amount)]);
    } else if (type === 'merma') {
      headers = ['Fecha', 'Insumo', 'Cantidad', 'Unidad', 'Motivo', 'Costo'];
      const waste = await db.getAllWaste({ dateFrom, dateTo });
      rows = waste.map((w) => [w.created_at, w.item_name, w.quantity, w.unit, w.reason, money(w.cost)]);
    } else if (type === 'asistencia') {
      headers = ['Fecha y hora', 'Empleado', 'Movimiento'];
      const attendance = await db.getAllAttendance({ dateFrom, dateTo });
      rows = attendance.map((a) => [a.timestamp, a.employee_name, a.type === 'entrada' ? 'Entrada' : 'Salida']);
    } else if (type === 'nomina') {
      headers = ['Semana (lunes)', 'Empleado', 'Salario', 'Bono acreditado', 'Monto bono', 'Total a pagar'];
      const payroll = await db.getPayrollHistory({ weekFrom: dateFrom, weekTo: dateTo });
      rows = payroll.map((p) => [p.week_start, p.employee_name, money(p.salary), p.bonus_credited ? 'Sí' : 'No', money(p.bonus_amount), money(p.total)]);
    } else {
      throw new Error('Tipo de reporte no reconocido.');
    }

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar reporte a CSV',
      defaultPath: defaultName,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if (result.canceled || !result.filePath) return { cancelled: true };

    await fs.promises.writeFile(result.filePath, toCsv(headers, rows), 'utf8');
    return { cancelled: false, path: result.filePath };
  });

  safeHandle('export:printReport', async (dateFrom, dateTo) => {
    const report = await db.computeProfitability(dateFrom, dateTo);
    const costsList = await db.getAllCosts({ dateFrom, dateTo });
    const wasteList = await db.getAllWaste({ dateFrom, dateTo });
    const settings = await db.getAllSettings();

    return printFullReport({ report, costsList, wasteList, settings });
  });

  // ------------------------------------------------------------------
  // HISTORIAL UNIFICADO
  // ------------------------------------------------------------------
  safeHandle('history:get', (filters = {}) => db.getUnifiedHistory(filters));

  safeHandle('history:exportCsv', async (filters = {}) => {
    const { rows } = await db.getUnifiedHistory(filters);
    const headers = ['Fecha', 'Tipo', 'Detalle', 'Productos (cant x nombre @ subtotal)', 'Total', 'Método', 'Autorizó / Cliente', 'Folio'];
    const dataRows = rows.map((r) => {
      const productos = (r.items || [])
        .map((it) => `${it.quantity}x ${it.name} @ ${money(it.subtotal)}`)
        .join(' | ');
      return [
        r.fecha, HISTORY_TIPO_LABELS[r.tipo] || r.tipo, r.detalle, productos, money(r.total), r.metodoLabel, r.autorizoCliente, r.folio || ''
      ];
    });
    const defaultName = `historial_sucursal${db.getCurrentBranchId()}_${filters.startDate || 'inicio'}_a_${filters.endDate || 'hoy'}.csv`;

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar historial a CSV',
      defaultPath: defaultName,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if (result.canceled || !result.filePath) return { cancelled: true };

    await fs.promises.writeFile(result.filePath, toCsv(headers, dataRows), 'utf8');
    return { cancelled: false, path: result.filePath };
  });

  safeHandle('history:exportPdf', async (filters = {}) => {
    const { rows, kpis } = await db.getUnifiedHistory(filters);
    const settings = await db.getAllSettings();
    return printHistoryReport({ rows, kpis, filters, settings });
  });

  // ------------------------------------------------------------------
  // IMPRESIÓN DE TICKETS (equipo externo: impresora térmica/POS)
  // ------------------------------------------------------------------
safeHandle('printers:list', async () => {
  return mainWindow.webContents.getPrintersAsync();
});

safeHandle('print:ticket', async (saleId) => {
  console.log('🖨️ Solicitud de impresión para venta:', saleId);

  const sale = await db.getSaleById(saleId);

  if (!sale) {
    throw new Error(`Venta no encontrada con ID: ${saleId}`);
  }

  console.log('🖨️ Venta encontrada:', sale);

  const settings = await db.getAllSettings();

  console.log('🖨️ Configuración:', settings);

  if (!isPrinterEnabled(settings)) {
    console.log('🖨️ Impresión deshabilitada en Ajustes. Se omite.');
    return { success: false, reason: 'disabled' };
  }

  const result = await printTicketWindow(sale, settings);

  console.log('🖨️ Resultado impresión:', result);

  if (result.success) {
    await db.markSalePrinted(saleId);
  }

  return result;
});

// Imprime un ticket de prueba (Ajustes -> Impresión -> "Imprimir prueba").
// A propósito ignora printer_enabled: sirve justo para probar el hardware
// aunque la impresión automática esté deshabilitada.
safeHandle('printer:test', async () => {
  const settings = await db.getAllSettings();
  return printTestTicket(settings);
});

// Botón de prueba en Ajustes -> Diagnóstico: dispara un error real hacia
// Sentry (captureException explícito, ya que ipcMain.handle atrapa el
// throw y lo convierte en respuesta IPC antes de que llegue al manejador
// global de excepciones del proceso).
safeHandle('sentry:test', () => {
  const err = new Error('WINGS TEST ERROR');
  if (SENTRY_DSN) {
    require('@sentry/electron/main').captureException(err);
  }
  throw err;
});
}
// Abre una ventana visible con el reporte completo y despliega el diálogo de
// impresión del sistema (permite elegir impresora o "Guardar como PDF").
//
// NOTA IMPORTANTE: 'report-rendered' es un canal IPC GLOBAL (ipcRenderer.send,
// no invoke), por lo que si esta función se llama más de una vez seguida
// (o se solapa con otra ventana) los listeners viejos pueden quedar activos
// y disparar operaciones sobre una ventana ya destruida (BrowserWindow /
// WebContents "destroyed"). Por eso aquí se filtra el evento por remitente,
// se limpia siempre el listener y el timeout, y se comprueba isDestroyed()
// antes de tocar la ventana.
function printFullReport(payload) {
  return new Promise((resolve) => {
    const reportWin = new BrowserWindow({
      width: 900,
      height: 1000,
      webPreferences: {
        preload: path.join(__dirname, 'report-preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    let settled = false;
    let timeoutId;

    const cleanup = () => {
      ipcMain.removeListener('report-rendered', onRendered);
      if (timeoutId) clearTimeout(timeoutId);
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onRendered = (event) => {
      if (reportWin.isDestroyed() || event.sender !== reportWin.webContents) return;
      reportWin.webContents.print({ printBackground: true }, (success, reason) => {
        finish({ success, reason: reason || null });
      });
    };

    ipcMain.on('report-rendered', onRendered);

    reportWin.on('closed', () => finish({ success: false, reason: 'window-closed' }));

    reportWin.loadFile('report-print.html');

    reportWin.webContents.once('did-finish-load', () => {
      if (!reportWin.isDestroyed()) {
        reportWin.webContents.send('report-data', payload);
      }
    });

    timeoutId = setTimeout(() => finish({ success: false, reason: 'timeout' }), 10000);
  });
}

// Igual que printFullReport pero para el Historial Unificado: ventana e IPC
// propios ('history-report-*') para no pisarse con una impresión de reporte
// normal que esté en curso al mismo tiempo.
function printHistoryReport(payload) {
  return new Promise((resolve) => {
    const reportWin = new BrowserWindow({
      width: 1000,
      height: 1000,
      webPreferences: {
        preload: path.join(__dirname, 'history-print-preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    let settled = false;
    let timeoutId;

    const cleanup = () => {
      ipcMain.removeListener('history-report-rendered', onRendered);
      if (timeoutId) clearTimeout(timeoutId);
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onRendered = (event) => {
      if (reportWin.isDestroyed() || event.sender !== reportWin.webContents) return;
      reportWin.webContents.print({ printBackground: true }, (success, reason) => {
        finish({ success, reason: reason || null });
      });
    };

    ipcMain.on('history-report-rendered', onRendered);

    reportWin.on('closed', () => finish({ success: false, reason: 'window-closed' }));

    reportWin.loadFile('history-print.html');

    reportWin.webContents.once('did-finish-load', () => {
      if (!reportWin.isDestroyed()) {
        reportWin.webContents.send('history-report-data', payload);
      }
    });

    timeoutId = setTimeout(() => finish({ success: false, reason: 'timeout' }), 10000);
  });
}

// Ancho físico del rollo térmico configurado en Ajustes -> Impresión.
// settings.ticket_width guarda '58' o '80' (string); cualquier otro valor
// (incluida su ausencia, instalaciones previas a este ajuste) cae en 58mm,
// que es el default que ya traía la app.
function getTicketWidthMm(rawWidth) {
    return rawWidth === '80' ? 80 : 58;
}

// pageSize en micrones para webContents.print(). El alto (297mm) es solo un
// límite generoso: las impresoras térmicas de rollo cortan según el
// contenido real recibido, no según este alto declarado, así que no genera
// papel en blanco de más.
function getThermalPageSize(rawWidth) {
    const widthMm = getTicketWidthMm(rawWidth);
    return { width: widthMm * 1000, height: 297000 };
}

// true salvo que el usuario haya apagado explícitamente el toggle en
// Ajustes -> Impresión; así una instalación existente sin este ajuste
// guardado sigue imprimiendo igual que antes.
function isPrinterEnabled(settings) {
    return settings?.printer_enabled !== 'false';
}

// Ticket de prueba para Ajustes -> Impresión -> "Imprimir prueba": imprime
// dos reglas de 32 y 48 caracteres (referencias estándar de 58mm/80mm) para
// que se pueda verificar a simple vista que el papel cargado corresponde al
// ancho configurado, sin depender de tener una venta real a la mano.
function buildTestRuler(n) {
    return Array.from({ length: n }, (_, i) => String((i + 1) % 10)).join('');
}

function printTestTicket(settings) {
    return new Promise((resolve) => {
        const widthMm = getTicketWidthMm(settings?.ticket_width);
        const configuredPrinter = String(settings?.printer_name || '').trim();

        const html = `
        <html><head><meta charset="utf-8"><style>
          @page { size: ${widthMm}mm auto; margin: 0; }
          body { width: ${widthMm}mm; font-family: 'Courier New', monospace; font-size: 12px; margin: 0; padding: 3mm; color: #000; }
          .c { text-align: center; }
          .b { font-weight: bold; }
          .sep { border-top: 1px dashed #000; margin: 6px 0; }
          .ruler { white-space: pre; }
        </style></head><body>
          <div class="c b">PRUEBA DE IMPRESIÓN</div>
          <div class="c">Papel configurado: ${widthMm}mm</div>
          <div class="sep"></div>
          <div>Línea de 32 caracteres (ref. 58mm):</div>
          <div class="ruler">${buildTestRuler(32)}</div>
          <div class="sep"></div>
          <div>Línea de 48 caracteres (ref. 80mm):</div>
          <div class="ruler">${buildTestRuler(48)}</div>
          <div class="sep"></div>
          <div class="c">Si ambas líneas se ven completas<br>y sin cortarse, el ancho está bien.</div>
        </body></html>`;

        const win = new BrowserWindow({ show: false, width: 320, height: 600 });

        const finish = (result) => {
            if (!win.isDestroyed()) win.close();
            resolve(result);
        };

        win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
            .then(() => new Promise((r) => setTimeout(r, 400)))
            .then(() => {
                const printOptions = {
                    printBackground: true,
                    margins: { marginType: 'none' },
                    pageSize: getThermalPageSize(settings?.ticket_width)
                };

                if (configuredPrinter) {
                    printOptions.silent = true;
                    printOptions.deviceName = configuredPrinter;
                } else {
                    printOptions.silent = false;
                }

                win.webContents.print(printOptions, (success, reason) => {
                    finish({ success, reason: reason || null, printer: configuredPrinter || null });
                });
            })
            .catch((err) => finish({ success: false, reason: err.message }));
    });
}

// Abre una ventana oculta, renderiza el ticket y lo envía a la impresora
// configurada en Ajustes (o al diálogo de impresión si no hay ninguna asignada).
//
// Mismo problema que printFullReport: 'ticket-rendered' es un canal global.
// Si se dispara un segundo cobro (Ventas o Comandas) mientras el listener de
// una impresión anterior seguía vivo (por ejemplo tras un timeout), ese
// listener viejo intentaba imprimir/cerrar una ventana ya destruida y
// Electron lanzaba "TypeError: Object has been destroyed" en el proceso
// principal, abortando el cobro/impresión. Se corrige filtrando por
// remitente, evitando doble resolución y verificando isDestroyed() siempre
// antes de usar la ventana.
function printTicketWindow(saleData, settings) {
    return new Promise((resolve) => {

        const ticketWin = new BrowserWindow({
            width: 320,
            height: 600,
            show: false,
            webPreferences: {
                preload: path.join(__dirname, 'ticket-preload.js'),
                contextIsolation: true,
                nodeIntegration: false
            }
        });

        let settled = false;
        let timeoutId = null;

        const cleanup = () => {
            ipcMain.removeListener('ticket-rendered', onRendered);

            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
        };

        const finish = (result) => {
            if (settled) return;

            settled = true;
            cleanup();

            console.log('======================================');
            console.log('RESULTADO DE IMPRESIÓN');
            console.log(result);
            console.log('======================================');

            if (!ticketWin.isDestroyed()) {
                try {
                    ticketWin.close();
                } catch (err) {
                    console.warn(
                        'No se pudo cerrar ventana del ticket:',
                        err.message
                    );
                }
            }

            resolve(result);
        };

        const onRendered = (event) => {

            if (
                settled ||
                ticketWin.isDestroyed() ||
                event.sender !== ticketWin.webContents
            ) {
                return;
            }

            console.log('Ticket renderizado correctamente.');

            const configuredPrinter =
                String(settings?.printer_name || '').trim();

            console.log(
                'Impresora configurada:',
                configuredPrinter || '(ninguna)'
            );

            const printOptions = {
                silent: false,
                printBackground: true,
                margins: {
                    marginType: 'none'
                },
                pageSize: getThermalPageSize(settings?.ticket_width)
            };

            if (configuredPrinter) {
                printOptions.silent = true;
                printOptions.deviceName = configuredPrinter;

                console.log(
                    'Intentando imprimir en:',
                    configuredPrinter
                );
            } else {
                console.log(
                    'No hay impresora configurada. Se abrirá el diálogo de impresión.'
                );
            }

            ticketWin.webContents.print(
                printOptions,
                (success, reason) => {

                    console.log('🖨️ PRINT CALLBACK');
                    console.log('success:', success);
                    console.log('reason:', reason);

                    finish({
                        success: success,
                        reason: reason || null,
                        printer: configuredPrinter || null
                    });
                }
            );
        };

        ipcMain.on('ticket-rendered', onRendered);

        ticketWin.on('closed', () => {
            if (!settled) {
                finish({
                    success: false,
                    reason: 'window-closed'
                });
            }
        });

        // IMPORTANTE:
        // Registrar did-finish-load ANTES de loadFile().
        ticketWin.webContents.once(
            'did-finish-load',
            () => {

                if (ticketWin.isDestroyed()) {
                    return;
                }

                console.log(
                    'ticket.html cargado correctamente.'
                );

                ticketWin.webContents.send(
                    'ticket-data',
                    {
                        sale: saleData,
                        settings: settings || {}
                    }
                );
            }
        );

        ticketWin.loadFile(
            path.join(__dirname, 'ticket.html')
        ).catch((err) => {

            console.error(
                'No se pudo cargar ticket.html:',
                err
            );

            finish({
                success: false,
                reason: `Error cargando ticket.html: ${err.message}`
            });
        });

        timeoutId = setTimeout(() => {

            console.error(
                'Tiempo agotado esperando la impresión del ticket.'
            );

            finish({
                success: false,
                reason: 'timeout'
            });

        }, 15000);
    });
}