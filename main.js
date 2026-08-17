const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
autoUpdater.logger = log;
log.transports.file.level = 'info';

let mainWindow;
let currentSession = null; // { id, username, displayName, role }
const db = require('./db'); // capa de datos sobre Supabase

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

app.whenReady().then(async () => {
  try {
    await db.init(); // siembra las cuentas por defecto en Supabase si hace falta
  } catch (err) {
    console.error('Error al inicializar Supabase:', err);
  }
  db.subscribeToNewSales(handleIncomingSale, (connected) => {
    isRealtimeConnected = connected;
    broadcastRealtimeStatus();
  });
  registerIpcHandlers();
  createWindow();

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

function safeHandle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(`Error en ${channel}:`, err);
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function money(n) {
  return (Number(n) || 0).toFixed(2);
}

function registerIpcHandlers() {
  function requireAdmin() {
    if (!currentSession || currentSession.role !== 'admin') {
      throw new Error('Se requiere una cuenta de administrador para esta acción.');
    }
  }

  // ------------------------------------------------------------------
  // AUTENTICACIÓN Y CUENTAS
  // ------------------------------------------------------------------
  safeHandle('auth:login', async (username, password) => {
    const session = await db.login(username, password);
    currentSession = session;
    return currentSession;
  });

  safeHandle('auth:logout', () => {
    currentSession = null;
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
    requireAdmin();
    return db.getAllUsers();
  });

  safeHandle('users:create', (data) => {
    requireAdmin();
    return db.createUser(data);
  });

  safeHandle('users:update', (id, data) => {
    requireAdmin();
    return db.updateUser(id, data);
  });

  safeHandle('users:remove', (id) => {
    requireAdmin();
    if (currentSession.id === id) throw new Error('No puedes eliminar la cuenta con la que iniciaste sesión.');
    return db.removeUser(id);
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

  // ------------------------------------------------------------------
  // INVENTARIOS
  // ------------------------------------------------------------------
  safeHandle('inventory:getAll', () => db.getAllInventory());
  safeHandle('inventory:create', (data) => db.createInventoryItem(data));
  safeHandle('inventory:update', (id, data) => db.updateInventoryItem(id, data));
  safeHandle('inventory:remove', (id) => db.removeInventoryItem(id));

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
    const win = new BrowserWindow({ show: false, width: 302, height: 800, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise(r => setTimeout(r, 800));
    win.webContents.print({ silent: false, printBackground: true }, () => {
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
  safeHandle('payroll:getDetail', (employeeName, weekStart, weekEnd) => db.getPayrollDetail(employeeName, weekStart, weekEnd));
  safeHandle('payroll:close', (weekStart, weekEnd) =>
    db.closePayrollWeek(weekStart, weekEnd, currentSession ? currentSession.username : null));

  // ------------------------------------------------------------------
  // AJUSTES
  // ------------------------------------------------------------------
  safeHandle('settings:getAll', () => db.getAllSettings());
  safeHandle('settings:set', (key, value) => db.setSetting(key, value));

  // ------------------------------------------------------------------
  // EXPORTACIÓN DE REPORTES (CSV y reporte imprimible)
  // ------------------------------------------------------------------
  safeHandle('export:csv', async (type, dateFrom, dateTo) => {
    let headers = [];
    let rows = [];
    const defaultName = `reporte_${type}_${dateFrom}_a_${dateTo}.csv`;

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

    fs.writeFileSync(result.filePath, toCsv(headers, rows), 'utf8');
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

  const result = await printTicketWindow(sale, settings);

  console.log('🖨️ Resultado impresión:', result);

  if (result.success) {
    await db.markSalePrinted(saleId);
  }

  return result;
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
                }
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