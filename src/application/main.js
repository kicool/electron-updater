// main.js — 启动器（主进程）
// 职责：解析 release 工作树 → 启动即检测并 pull 更新 → 加载渲染层 →
//       渲染层改动自动 reload（无重启）；主进程/preload/依赖改动提示重启。
'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const updater = require('./updater');

// CONFIG = 契约注册表：所有路径 / 开关 / bridge API 名单的唯一来源（见 registry.js）
const CONFIG = require('./registry');
let win = null;
let appRoot = null;
let lastStatus = null; // 缓存最近一次 checkUpdate 结果，reload/启动后直接复用，避免二次 fetch 造成「初始化…」空窗


// 契约自检：路径配置错了要在【窗口打开前】报清楚，而不是白屏或静默失败
function verifyContract(appRoot) {
  const missing = [];
  const check = (label, p) => { if (!fs.existsSync(p)) missing.push(`${label}: ${p}`); };
  check('appEntry', path.join(appRoot, CONFIG.appEntry));
  check('rendererDir', path.join(appRoot, CONFIG.rendererDir));
  check('preload', CONFIG.preloadPath);
  if (missing.length) {
    throw new Error('契约校验失败，以下路径不存在：\n  ' + missing.join('\n  ') +
      '\n  请核对 src/application/registry.json 与 config.json');
  }
  console.log('[contract]\n  ' + CONFIG.describe());
}

// 检测 + （可选）拉取。autoPull=true 时落后者直接 pull，并返回改动文件与是否需重启
async function checkUpdate(autoPull) {
  try {
    await updater.fetch(CONFIG.remote, { cwd: appRoot });
  } catch (e) {
    return { ok: false, offline: true, error: String(e.stderr || e.message) };
  }
  const cmp = await updater.compare({ remote: CONFIG.remote, branch: CONFIG.branch, cwd: appRoot });
  const version = await updater.getVersion({ cwd: appRoot });

  if (cmp.offline) return { ok: false, offline: true, version };
  if (!cmp.behind) return { ok: true, updated: false, behind: false, version, offline: false };

  if (!autoPull) return { ok: true, updated: false, behind: true, version, offline: false };

  const files = await updater.diffFiles(cmp.local, cmp.remote, { cwd: appRoot });
  await updater.pull({ remote: CONFIG.remote, branch: CONFIG.branch, cwd: appRoot });
  const onlyRenderer = updater.onlyRendererChanges(files, CONFIG.rendererPrefix);
  const newVersion = await updater.getVersion({ cwd: appRoot });
  return {
    ok: true, updated: true, behind: false,
    version: newVersion, prevVersion: version,
    files, onlyRenderer, needsRestart: !onlyRenderer, offline: false,
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 920, height: 620,
    webPreferences: {
      preload: CONFIG.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(appRoot, CONFIG.appEntry));
  // 渲染进程报错转发到启动终端（npm start 可见），排障用
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) console.log('[renderer]', msg);
  });
  win.webContents.on('did-finish-load', async () => {
    try {
      // 启动或热更 reload 后，状态已由「whenReady 的启动 pull」或「上次手动检查」得出，
      // 直接复用 lastStatus，避免再发一次网络 fetch（否则 reload 后会出现「初始化…」空窗）。
      // 仅在极端情况 lastStatus 为空时（理论上不会）才回退到一次 fetch。
      const status = lastStatus || await checkUpdate(false);
      if (win) {
        win.webContents.send('update:status', status);
        win.webContents.send('update:config', { autoPull: CONFIG.autoPull });
      }
    } catch (e) {
      console.error('[main] 启动状态检查失败:', e);
      if (win) win.webContents.send('update:status', { ok: false, offline: true, error: String(e) });
    }
  });
}

app.whenReady().then(async () => {
  try {
    appRoot = await updater.resolveAppTree(CONFIG);
    verifyContract(appRoot);
  } catch (e) {
    console.error('[main] ' + e.message);
    dialog.showErrorBox('启动失败：契约校验未通过', e.message);
    app.quit();
    return;
  }
  // 启动即检测并按 autoPull 配置决定是否拉取（autoPull=true 时应用自动保持最新）
  lastStatus = await checkUpdate(CONFIG.autoPull);
  createWindow();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// 手动检查更新（渲染层按钮触发）。
// autoPull=true：落后于远程则直接拉取，仅渲染层改动时自动 reload（无重启热更）。
// autoPull=false（仅提示模式）：只比对、不拉取，由渲染层展示「更新」按钮让用户手动触发。
ipcMain.handle('check-update', async () => {
  const s = await checkUpdate(CONFIG.autoPull);
  lastStatus = s; // 缓存，reload 后 did-finish-load 直接复用，不再二次 fetch
  if (CONFIG.autoPull && s.ok && s.updated && s.onlyRenderer && win) {
    win.webContents.reload(); // 重新加载工作树里的新 renderer.js —— 无重启
  }
  return s;
});

// 手动触发实际拉取（notify-only 模式下「更新」按钮调用；或用户想手动 pull）
ipcMain.handle('apply-update', async () => {
  const s = await checkUpdate(true);
  lastStatus = s;
  if (s.ok && s.updated && s.onlyRenderer && win) {
    win.webContents.reload();
  }
  return s;
});
// 重启应用以应用主进程/preload/依赖更新
ipcMain.on('relaunch', () => { app.relaunch(); app.quit(); });

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
