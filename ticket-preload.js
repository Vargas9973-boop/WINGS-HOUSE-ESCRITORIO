require('./sentryConfig').initRendererSentry();

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ticketAPI', {
  onTicketData: (callback) => {
    ipcRenderer.on('ticket-data', (event, payload) => callback(payload));
  },
  notifyRendered: () => ipcRenderer.send('ticket-rendered')
});
