'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('deviceFarm', Object.freeze({
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  start: (config) => ipcRenderer.invoke('simulator:start', config),
  stop: () => ipcRenderer.invoke('simulator:stop'),
  getRoadCoverage: (options) => ipcRenderer.invoke('road:coverage', options),
  prepareRoadRoutes: (options) => ipcRenderer.invoke('road:prepare', options),
  cancelPreparation: () => ipcRenderer.invoke('road:cancel-preparation'),
  selectRoutePack: (digests, options) => ipcRenderer.invoke('road:select-pack', digests, options),
  exportImeis: (options) => ipcRenderer.invoke('imei:export', options),
  showLogFile: () => ipcRenderer.invoke('logs:show'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.send('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  onMetrics: (callback) => subscribe('simulator:metrics', callback),
  onLog: (callback) => subscribe('simulator:log', callback),
  onState: (callback) => subscribe('simulator:state', callback),
  onRoadPreparationProgress: (callback) => subscribe('road:preparation-progress', callback),
  onWindowMaximized: (callback) => subscribe('window:maximized', callback)
}));

