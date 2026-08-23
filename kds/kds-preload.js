// Puente de contexto para kds.html. La TV nunca ve credenciales de Supabase:
// main.js hace todas las consultas y solo empuja el resultado ya armado por
// IPC (kds:orders / kds:online), igual que preload.js hace para el resto de
// la app -- así el KDS "sin login" tampoco expone nada sensible si alguien
// desconecta la TV y la conecta a otra cosa.
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || res.ok === undefined) return res;
  if (!res.ok) throw new Error(res.error || `Error en ${channel}`);
  return res.data;
}

contextBridge.exposeInMainWorld('kdsAPI', {
  onOrders: (cb) => ipcRenderer.on('kds:orders', (event, orders) => cb(orders)),
  onOnline: (cb) => ipcRenderer.on('kds:online', (event, online) => cb(online)),
  onBranding: (cb) => ipcRenderer.on('kds:branding', (event, branding) => cb(branding)),
  cook: (saleId) => call('kds:updateStatus', saleId, 'en_preparacion'),
  markReady: (saleId) => call('kds:updateStatus', saleId, 'lista'),
  markDelivered: (saleId) => call('kds:updateStatus', saleId, 'entregada'),
  // Esc: la ventana del KDS se pone en fullscreen nativo de Electron
  // (kdsWindow.setFullScreen(true) en main.js), no fullscreen del DOM/CSS --
  // el renderer no puede salir de eso por su cuenta, necesita pedírselo al
  // proceso principal.
  exitFullscreen: () => ipcRenderer.send('kds:exit-fullscreen')
});
