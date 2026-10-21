const { contextBridge, ipcRenderer } = require('electron');
const call = async (ch, ...a) => { const r = await ipcRenderer.invoke(ch, ...a); if (!r.ok) throw new Error(r.error); return r.value; };
contextBridge.exposeInMainWorld('api', {
  load: () => call('data:load'),
  batch: (ops) => call('data:batch', ops),
  saveFile: (name, content) => call('file:save', name, content),
  chooseDir: () => call('dir:choose'),
  openDir: () => call('dir:open'),
  exportBackup: () => call('backup:export'),
  importBackup: () => call('backup:import'),
  setLoginItem: (on) => call('app:loginItem', on),
  importXlsx: () => call('xlsx:import'),
  saveTemplate: () => call('xlsx:template'),
  printPDF: (name, landscape) => call('print:pdf', name, landscape),
  print: (landscape) => call('print:direct', landscape),
  notify: (title, body) => call('app:notify', title, body),
  onChanged: (fn) => ipcRenderer.on('data:changed', (_e, d) => fn(d)),
});
