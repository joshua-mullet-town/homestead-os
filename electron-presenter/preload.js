const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('presenter', {
  onQueueUpdate: (callback) => {
    ipcRenderer.on('queue-update', (event, queue) => callback(queue));
  },
  respond: (id, button, text, keepCard) => ipcRenderer.invoke('respond', { id, button, text, keepCard }),
  dismiss: (id) => ipcRenderer.invoke('dismiss', { id }),
  getQueue: () => ipcRenderer.invoke('get-queue'),
  getHistory: (sessionId) => ipcRenderer.invoke('get-history', sessionId),
  getMessageQueue: () => ipcRenderer.invoke('get-message-queue'),
  deleteQueueItem: (id) => ipcRenderer.invoke('delete-queue-item', id),
  readdQueueItem: (data) => ipcRenderer.invoke('readd-queue-item', data),
  openUrl: (url) => ipcRenderer.send('open-url', url),
  runCommand: (command) => ipcRenderer.send('run-command', command),
  phoneOpenUri: (uri) => ipcRenderer.send('phone-open-uri', uri),
  minimize: () => ipcRenderer.send('minimize-window'),
  collapse: () => ipcRenderer.send('collapse-presenter'),
  setOpacity: (value) => ipcRenderer.send('set-opacity', value),
  setFontSize: (value) => ipcRenderer.send('set-font-size', value),
  // Report the active reading-mode theme so main.js can theme the collapsed bar.
  setTheme: (preset) => ipcRenderer.send('set-theme', preset),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  onSettingsUpdate: (callback) => {
    ipcRenderer.on('settings-update', (event, settings) => callback(settings));
  },
  // Session lifecycle events forwarded from the main-process Socket.IO client.
  // Payload: { type: 'created' | 'deleted', payload: { sessionId, parent? } }
  onSessionEvent: (callback) => {
    ipcRenderer.on('session-event', (event, data) => callback(data));
  },
  // Fullscreen toggle via setSimpleFullScreen (stays on current macOS Space)
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  getFullscreenState: () => ipcRenderer.invoke('get-fullscreen-state'),
  onFullscreenUpdate: (callback) => {
    ipcRenderer.on('fullscreen-update', (event, data) => callback(data));
  },
});
