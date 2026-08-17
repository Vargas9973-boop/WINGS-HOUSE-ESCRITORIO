const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('historyReportWindowAPI', {
  onReportData: (callback) => {
    ipcRenderer.on('history-report-data', (event, payload) => callback(payload));
  },
  notifyRendered: () => ipcRenderer.send('history-report-rendered')
});
