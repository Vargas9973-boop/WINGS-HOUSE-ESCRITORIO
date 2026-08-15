const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reportWindowAPI', {
  onReportData: (callback) => {
    ipcRenderer.on('report-data', (event, payload) => callback(payload));
  },
  notifyRendered: () => ipcRenderer.send('report-rendered')
});
