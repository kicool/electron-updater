// preload.js — 桥接层（contextIsolation 下安全暴露给渲染进程）
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  applyUpdate: () => ipcRenderer.invoke('apply-update'),
  relaunch: () => ipcRenderer.send('relaunch'),
  onStatus: (cb) => ipcRenderer.on('update:status', (_e, s) => cb(s)),
  onConfig: (cb) => ipcRenderer.on('update:config', (_e, c) => cb(c)),
});
