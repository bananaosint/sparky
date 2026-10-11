const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spark', {
  on: (channel, fn) => ipcRenderer.on(channel, (_event, data) => fn(data)),
  ready: () => ipcRenderer.send('ready'),
  sendMessage: (message) => ipcRenderer.send('send-message', message),
  stop: () => ipcRenderer.send('stop'),
  marathon: (request) => ipcRenderer.send('marathon', request),
  mission: (request) => ipcRenderer.invoke('mission', request),
  missions: () => ipcRenderer.invoke('missions'),
  missionView: (id) => ipcRenderer.invoke('mission-view', id),
  newChat: () => ipcRenderer.send('new-chat'),
  openFolder: () => ipcRenderer.send('open-folder'),
  answerPermission: (answer) => ipcRenderer.send('permission-answer', answer),
  cook: (text, options) => ipcRenderer.invoke('cook', text, options),
  quick: (history) => ipcRenderer.invoke('quick', history),
  auto: (history) => ipcRenderer.invoke('auto', history),
  cancelAuto: () => ipcRenderer.send('auto-cancel'),
  toggleTheme: () => ipcRenderer.invoke('toggle-theme'),
  setSettings: (changes) => ipcRenderer.invoke('set-settings', changes),
  openExternal: (url) => ipcRenderer.send('open-external', url),
});
