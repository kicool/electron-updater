// preload.js — 桥接层（contextIsolation 下安全暴露给渲染进程）
//
// window.api 的成员【由 registry.json 的 bridgeApi 决定】，不在本文件重复声明：
//   - 注册表列了但这里没实现 → 启动即报错（防止「渲染层以为有、其实没有」）
//   - 这里实现但注册表没列   → 同样报错（防止偷偷扩张 API 面）
// 这是「壳(freeze) ↔ 渲染层(hot)」的版本契约闸门。
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const contract = require('./registry');

const handlers = {
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  applyUpdate: () => ipcRenderer.invoke('apply-update'),
  relaunch: () => ipcRenderer.send('relaunch'),
  onStatus: (cb) => ipcRenderer.on('update:status', (_e, s) => cb(s)),
  onConfig: (cb) => ipcRenderer.on('update:config', (_e, c) => cb(c)),
};

const declared = contract.bridgeApi;
const unimplemented = declared.filter((k) => !Object.prototype.hasOwnProperty.call(handlers, k));
const undeclared = Object.keys(handlers).filter((k) => !declared.includes(k));

if (unimplemented.length || undeclared.length) {
  const msg = '[preload] window.api 契约不一致：' +
    (unimplemented.length ? `注册表声明但未实现: ${unimplemented.join(', ')}. ` : '') +
    (undeclared.length ? `已实现但未登记到 registry.json: ${undeclared.join(', ')}.` : '');
  throw new Error(msg);
}

const api = {};
for (const k of declared) api[k] = handlers[k];
contextBridge.exposeInMainWorld('api', api);
