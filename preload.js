require('./sentryConfig').initRendererSentry();

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Envuelve ipcRenderer.invoke y desempaqueta { ok, data, error }
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || res.ok === undefined) return res; // por si algún canal no usa safeHandle
  if (!res.ok) throw new Error(res.error || `Error en ${channel}`);
  return res.data;
}

contextBridge.exposeInMainWorld('api', {
  sendAction: (action) => ipcRenderer.send('send-action', action),
  // F1 (mostrar ayuda) y F5 (refrescar) llegan por aquí -- son los únicos
  // atajos globales (ver shortcuts.js) que necesitan que el renderer haga
  // algo; el resto de F1-F9 solo navega (mainWindow.loadFile), que no
  // necesita avisarle nada al renderer.
  onShortcut: (cb) => ipcRenderer.on('shortcut', (event, key) => cb(key))
});

contextBridge.exposeInMainWorld('db', {
  products: {
    getAll: () => call('products:getAll'),
    create: (data) => call('products:create', data),
    update: (id, data) => call('products:update', id, data),
    remove: (id) => call('products:remove', id),
    migrateCategories: () => call('products:migrateCategories')
  },
  promotions: {
    getAll: () => call('promotions:getAll'),
    create: (data) => call('promotions:create', data),
    update: (id, data) => call('promotions:update', id, data),
    remove: (id) => call('promotions:remove', id)
  },
  sales: {
    create: (payload) => call('sales:create', payload),
    getById: (id) => call('sales:getById', id),
    getAll: (filters) => call('sales:getAll', filters),
    markPrinted: (id) => call('sales:markPrinted', id)
  },
  employee: {
  getDailyConsumption: (employeeId) =>
    call('employee:getDailyConsumption', employeeId)
  },
  inventory: {
    getAll: () => call('inventory:getAll'),
    create: (data) => call('inventory:create', data),
    update: (id, data) => call('inventory:update', id, data),
    remove: (id) => call('inventory:remove', id),
    addStock: (id, data) => call('inventory:addStock', id, data),
    getMovements: (id) => call('inventory:getMovements', id),
    checkLowStock: () => call('inventory:checkLowStock')
  },
  recipes: {
    getForProduct: (productId) => call('recipes:getForProduct', productId),
    setForProduct: (productId, rows) => call('recipes:setForProduct', productId, rows),
    getCost: (productId) => call('recipes:getCost', productId),
    getProductIdsWithRecipe: () => call('recipes:getProductIdsWithRecipe'),
    getAllCosts: () => call('recipes:getAllCosts'),
    getAllWithStock: () => call('recipes:getAllWithStock')
  },
  waste: {
    getAll: (filters) => call('waste:getAll', filters),
    create: (data) => call('waste:create', data),
    getEmployeeBenefitConsumption: (dateFrom, dateTo) => call('waste:getEmployeeBenefitConsumption', dateFrom, dateTo)
  },
  costs: {
    getAll: (filters) => call('costs:getAll', filters),
    create: (data) => call('costs:create', data),
    remove: (id) => call('costs:remove', id)
  },
  reports: {
    profitability: (filters) => call('reports:profitability', filters)
  },
  employees: {
    getAll: () => call('employees:getAll'),
    create: (data) => call('employees:create', data),
    update: (id, data) => call('employees:update', id, data),
    remove: (id) => call('employees:remove', id)
  },
  attendance: {
    getToday: () => call('attendance:getToday'),
    getAll: (filters) => call('attendance:getAll', filters),
    register: (employeeId) => call('attendance:register', employeeId)
  },
  payroll: {
    getWeek: (weekStart) => call('payroll:getWeek', weekStart),
    setBonus: (payload) => call('payroll:setBonus', payload),
    history: (filters) => call('payroll:history', filters),
    pendientes: (weekStart) => call('payroll:pendientes', weekStart),
    getSettings: () => call('payroll:getSettings'),
    getWeekRange: (paydayNumber, referenceDate) => call('payroll:getWeekRange', paydayNumber, referenceDate),
    getData: (weekStart, weekEnd) => call('payroll:getData', weekStart, weekEnd),
    saveBono: (employeeId, weekEnd, acredita) => call('payroll:saveBono', employeeId, weekEnd, acredita),
    getDetail: (employeeName, weekStart, weekEnd) => call('payroll:getDetail', employeeName, weekStart, weekEnd),
    close: (weekStart, weekEnd) => call('payroll:close', weekStart, weekEnd)
  },
  users: {
    getAll: () => call('users:getAll'),
    create: (data) => call('users:create', data),
    update: (id, data) => call('users:update', id, data),
    remove: (id) => call('users:remove', id)
  },
  settings: {
    getAll: () => call('settings:getAll'),
    set: (key, value) => call('settings:set', key, value),
    // webUtils.getPathForFile es el reemplazo moderno de file.path (retirado
    // con contextIsolation) -- necesita correr aquí en preload, no en el
    // renderer aislado.
    getFilePath: (file) => webUtils.getPathForFile(file),
    uploadLogo: (filePath, fileName) => call('settings:uploadLogo', filePath, fileName),
    refreshBranding: () => call('settings:refreshBranding')
  },
  roles: {
    getAll: () => call('roles:getAll'),
    create: (data) => call('roles:create', data),
    update: (id, data) => call('roles:update', id, data),
    remove: (id) => call('roles:remove', id),
    getPermissions: (roleId) => call('roles:getPermissions', roleId),
    setPermissions: (roleId, permissions) => call('roles:setPermissions', roleId, permissions)
  },
  modifiers: {
    list: (groupName) => call('modifiers:list', groupName),
    create: (data) => call('modifiers:create', data),
    update: (id, data) => call('modifiers:update', id, data)
  },
  productModifierGroups: {
    getAll: () => call('productModifierGroups:getAll'),
    set: (productId, groupName, enabled, qty) => call('productModifierGroups:set', productId, groupName, enabled, qty)
  },
  promotionModifierGroups: {
    getAll: () => call('promotionModifierGroups:getAll'),
    set: (promotionId, groupName, enabled, qty) => call('promotionModifierGroups:set', promotionId, groupName, enabled, qty)
  },
  productComponents: {
    getForProduct: (productId) => call('productComponents:getForProduct', productId),
    setForProduct: (productId, rows) => call('productComponents:setForProduct', productId, rows),
    getAll: () => call('productComponents:getAll')
  }
});

contextBridge.exposeInMainWorld('auth', {
  login: (username, password) => call('auth:login', username, password),
  logout: () => call('auth:logout'),
  getSession: () => call('auth:getSession'),
  changePassword: (userId, newPassword) => call('auth:changePassword', userId, newPassword)
});

contextBridge.exposeInMainWorld('comandasAPI', {
  getTables: () => call('comandas:getTables'),
  openTable: (tableNumber) => call('comandas:openTable', tableNumber),
  getOpenSale: (tableNumber) => call('comandas:getOpenSale', tableNumber),
  getTakeoutOrders: () => call('comandas:getTakeoutOrders'),
  openTakeout: () => call('comandas:openTakeout'),
  setDeliveryStatus: (saleId, status) => call('comandas:setDeliveryStatus', saleId, status),
  getOpenSaleById: (saleId) => call('comandas:getOpenSaleById', saleId),
  addItem: (saleId, item) => call('comandas:addItem', saleId, item),
  updateItemQty: (itemId, quantity) => call('comandas:updateItemQty', itemId, quantity),
  removeItem: (itemId) => call('comandas:removeItem', itemId),
  closeTable: (saleId, payload) => call('comandas:closeTable', saleId, payload),
  cancelTable: (saleId) => call('comandas:cancelTable', saleId),
  assignDriver: (saleId, driverId, deliveryFee) => call('comandas:assignDriver', saleId, driverId, deliveryFee)
});

contextBridge.exposeInMainWorld('driversAPI', {
  getAll: () => call('drivers:getAll'),
  create: (name, phone) => call('drivers:create', name, phone),
  getPendingMoney: () => call('drivers:getPendingMoney'),
  liquidate: (driverId) => call('drivers:liquidate', driverId),
  getSalesByPaymentStatus: (status) => call('drivers:getSalesByPaymentStatus', status)
});

contextBridge.exposeInMainWorld('orderAlertAPI', {
  getActive: () => call('order-alert:getActive'),
  getStatus: () => call('order-alert:getStatus'),
  dismiss: (saleId) => ipcRenderer.send('order-alert:dismiss', saleId),
  reportFallbackSale: (row) => ipcRenderer.send('order-alert:fallback-sale', row),
  onStart: (cb) => ipcRenderer.on('order-alert:start', (event, payload) => cb(payload)),
  onStop: (cb) => ipcRenderer.on('order-alert:stop', (event, saleId) => cb(saleId)),
  onStatus: (cb) => ipcRenderer.on('order-alert:status', (event, connected) => cb(connected)),
  onNewSale: (cb) => ipcRenderer.on('order-alert:new-sale', (event, saleId) => cb(saleId))
});
// Avisa a caja/meseros cuando cocina marca una orden 'lista' en el KDS
// (ver kds/), sin que tengan que ir a ver la TV. main.js detecta la
// transición por Realtime y la manda por este único canal.
contextBridge.exposeInMainWorld('kdsReadyAPI', {
  onReady: (cb) => ipcRenderer.on('kds:ready', (event, info) => cb(info))
});
// Avisa cuando products/inventory cambian en Supabase (otra instalación, u
// otra sesión de esta misma) para que la pantalla activa se refresque sola
// (ver main.js::broadcastCatalogChanged / db.js::subscribeToCatalogChanges).
contextBridge.exposeInMainWorld('catalogRealtimeAPI', {
  onChanged: (cb) => ipcRenderer.on('catalog:changed', () => cb())
});

contextBridge.exposeInMainWorld('corteAPI', {
  getResumen: (fecha) => call('corte:getResumen', fecha),
  printTicket: (html) => call('corte:printTicket', html),
  setFondoInicial: (fecha, fondoInicial) => call('corte:setFondoInicial', fecha, fondoInicial),
  addMovimiento: (data) => call('corte:addMovimiento', data),
  removeMovimiento: (id) => call('corte:removeMovimiento', id),
  cerrar: (fecha, efectivoReal) => call('corte:cerrar', fecha, efectivoReal),
  getByFecha: (fecha) => call('corte:getByFecha', fecha),
  openCashDrawer: (adminUsername, adminPassword) => call('cashdrawer:openManual', adminUsername, adminPassword)
});

contextBridge.exposeInMainWorld('reportsAPI', {
  exportCsv: (type, dateFrom, dateTo) => call('export:csv', type, dateFrom, dateTo),
  printReport: (dateFrom, dateTo) => call('export:printReport', dateFrom, dateTo),
  cortes: (dateFrom, dateTo) => call('reports:cortes', { dateFrom, dateTo })
});

contextBridge.exposeInMainWorld('historyAPI', {
  get: (filters) => call('history:get', filters),
  exportCsv: (filters) => call('history:exportCsv', filters),
  exportPdf: (filters) => call('history:exportPdf', filters)
});

contextBridge.exposeInMainWorld('printerAPI', {
  list: () => call('printers:list'),
  printTicket: (saleId) => call('print:ticket', saleId),
  test: () => call('printer:test')
});

// Ticket de cocina de respaldo (independiente del KDS, ver main.js
// kitchen:printTicket) -- disponible desde el banner de alerta de comanda
// nueva y desde la pantalla de mesa en Comandas.
contextBridge.exposeInMainWorld('kitchenTicketAPI', {
  print: (saleId) => call('kitchen:printTicket', saleId)
});

contextBridge.exposeInMainWorld('biometricAPI', {
  getSettings: () => call('biometric:getSettings'),
  scan: (model) => call('biometric-scan', model),
  enroll: (employeeId) => call('biometric:enroll', employeeId),
  identify: () => call('biometric:identify')
});

contextBridge.exposeInMainWorld('sentryAPI', {
  triggerTestError: () => call('sentry:test')
});

contextBridge.exposeInMainWorld('systemAPI', {
  getInfo: () => call('system:getInfo'),
  checkForUpdate: () => call('system:checkForUpdate'),
  runDiagnostics: () => call('system:runDiagnostics'),
  reportProblem: (description) => call('system:reportProblem', description),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (event, status) => cb(status))
});
