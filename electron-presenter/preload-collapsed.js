const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('presenterBar', {
  expand: () => ipcRenderer.send('expand-presenter'),
  onQueueCount: (callback) => {
    ipcRenderer.on('queue-count', (event, count) => callback(count));
  },
  // Active reading-mode theme, pushed from main.js (mirrors queue-count).
  onTheme: (callback) => {
    ipcRenderer.on('theme', (event, preset) => callback(preset));
  },
});
