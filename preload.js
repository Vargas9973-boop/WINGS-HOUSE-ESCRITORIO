const { contextBridge, ipcRenderer } = require('electron');

// Envuelve ipcRenderer.invoke y desempaqueta { ok, data, error }
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || res.ok === undefined) return res; // por si algún canal no usa safeHandle
  if (!res.ok) throw new Error(res.error || `Error en ${channel}`);
  return res.data;
}

contextBridge.exposeInMainWorld('api', {
  sendAction: (action) => ipcRenderer.send('send-action', action)
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
    remove: (id) => call('inventory:remove', id)
  },
  waste: {
    getAll: (filters) => call('waste:getAll', filters),
    create: (data) => call('waste:create', data)
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
    set: (key, value) => call('settings:set', key, value)
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
  cancelTable: (saleId) => call('comandas:cancelTable', saleId)
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
contextBridge.exposeInMainWorld('corteAPI', {
  getResumen: (fecha) => call('corte:getResumen', fecha),
  printTicket: (html) => call('corte:printTicket', html),
  setFondoInicial: (fecha, fondoInicial) => call('corte:setFondoInicial', fecha, fondoInicial),
  addMovimiento: (data) => call('corte:addMovimiento', data),
  removeMovimiento: (id) => call('corte:removeMovimiento', id),
  cerrar: (fecha, efectivoReal) => call('corte:cerrar', fecha, efectivoReal),
  getByFecha: (fecha) => call('corte:getByFecha', fecha)
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
  printTicket: (saleId) => call('print:ticket', saleId)
});
