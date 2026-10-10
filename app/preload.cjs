const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spark', {
  on: (channel, fn) => ipcRenderer.on(channel, (_event, data) => fn(data)),
  ready: () => ipcRenderer.send('ready'),
  sendMessage: (message) => ipcRenderer.send('send-message', message),
  stop: () => ipcRenderer.send('stop'),
  newChat: () => ipcRenderer.send('new-chat'),
  openFolder: () => ipcRenderer.send('open-folder'),
  answerPermission: (answer) => ipcRenderer.send('permission-answer', answer),
  cook: (text) => ipcRenderer.invoke('cook', text),
  toggleTheme: () => ipcRenderer.invoke('toggle-theme'),
  setSettings: (changes) => ipcRenderer.invoke('set-settings', changes),
  openExternal: (url) => ipcRenderer.send('open-external', url),
});
