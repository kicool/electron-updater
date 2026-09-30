// main-smoke.js — 主进程接线冒烟测试（npm run smoke）
//
// 用 stub 顶掉 electron，把 main.js 完整跑一遍：verifyContract → collectEnv → checkUpdate
// → createWindow → did-finish-load → IPC。验证的是「接线」，不是「看着对」。
//
// 为什么需要它：core/ 有单测、契约有体检，但 main.js 是接线层，前面两项都碰不到它。
// 之前就吃过亏 —— preload 在沙箱里 require 失败静默挂掉，[contract] 打印却一切正常。
//
// 默认【不写】config.json。要验「界面改设置 → 落盘」这条路径请显式加 --write-config
// （跑完会还原；中断也不会留下半截文件，因为写在 try/finally 里）。
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..', '..');
const CFG = path.join(REPO, 'src/application/config.json');
const WRITE_CFG = process.argv.includes('--write-config');

const sent = [];
const winHandlers = {};
let loadedFile = null;
let reloadCount = 0;
const ipc = {};
let errorBox = null;
let quit = false;

const win = {
  webContents: {
    send: (ch, payload) => sent.push([ch, payload]),
    reload: () => { reloadCount++; },
    on: (ev, cb) => { (winHandlers[ev] = winHandlers[ev] || []).push(cb); },
  },
  loadFile: (p) => { loadedFile = p; },
};

const electronStub = {
  app: {
    whenReady: () => Promise.resolve(),
    getPath: () => path.join(require('os').tmpdir(), 'eu-smoke-userdata'),
    on: () => {}, relaunch: () => {}, quit: () => { quit = true; },
  },
  BrowserWindow: function () { Object.assign(this, win); return this; },
  ipcMain: { handle: (ch, fn) => { ipc[ch] = fn; }, on: (ch, fn) => { ipc[ch] = fn; } },
  dialog: { showErrorBox: (t, m) => { errorBox = t + ': ' + m; } },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const fail = (m) => { console.log('  ✗ ' + m); failed++; };

(async () => {
  console.log('== 冒烟：main.js 全链路（electron 用 stub）==');
  let backup = null;
  try {
    backup = fs.readFileSync(CFG, 'utf8');
    require(path.join(REPO, 'src/application/main.js'));
    await new Promise((r) => setTimeout(r, 300)); // 等 whenReady 链跑完

    if (errorBox) fail('启动就弹了错误框: ' + errorBox);
    else ok('verifyContract 通过（未弹错误框）');

    if (loadedFile && String(loadedFile).replace(/\\/g, '/').endsWith('src/application/renderer/index.html')) {
      ok('loadFile 加载入口正确');
    } else fail('loadFile 未加载正确入口: ' + loadedFile);

    for (const cb of winHandlers['did-finish-load'] || []) await cb();
    await new Promise((r) => setTimeout(r, 100));

    const status = sent.filter((s) => s[0] === 'update:status').pop();
    const config = sent.filter((s) => s[0] === 'update:config').pop();

    if (!status) fail('没有下发 update:status');
    else ok(`update:status → ok=${status[1].ok} skipped=${!!status[1].skipped} version=${status[1].version}`);

    if (!config || !config[1]) fail('没有下发 update:config');
    else {
      const c = config[1];
      ok(`update:config → policy.enabled=${c.policy.enabled} onStartup=${c.policy.onStartup} schedule=${c.policy.schedule.mode}`);
      if (typeof c.skipUpdate !== 'boolean') fail('skipUpdate 未下发（界面靠它决定是否置灰开关）');
      else ok(`skipUpdate=${c.skipUpdate} 已下发`);
      if (!Array.isArray(c.units) || !c.units.length) fail('units 未下发（界面白名单表格会空）');
      else ok(`units 下发 ${c.units.length} 个`);
      if (!c.env || !c.env.contractVersion) fail('env.contractVersion 缺失');
      else ok(`env.contractVersion=${c.env.contractVersion} · preload=${c.env.preload}`);
      ok('schedule.nextAt=' + (c.schedule && c.schedule.nextAt ? new Date(c.schedule.nextAt).toLocaleString() : '未安排'));
    }

    if (ipc['check-update']) {
      const s = await ipc['check-update']();
      ok(`IPC check-update → ok=${s.ok} mode=${s.mode}`);
    } else fail('未注册 check-update');

    if (WRITE_CFG) {
      if (ipc['set-update-policy']) {
        const r = await ipc['set-update-policy']({}, { enabled: false, schedule: { mode: 'dailyAt' } });
        if (!r.ok) fail('set-update-policy 失败: ' + r.error);
        else {
          ok(`IPC set-update-policy → enabled=${r.policy.enabled} mode=${r.policy.schedule.mode}` +
            ` dailyAt=${r.policy.schedule.dailyAt}（intervalMinutes 保留=${r.policy.schedule.intervalMinutes}）`);
          const w = JSON.parse(fs.readFileSync(CFG, 'utf8'));
          if (w.updatePolicy && w.updatePolicy.enabled === false) ok('config.json 已落盘');
          else fail('config.json 未写入');
        }
      } else fail('未注册 set-update-policy');
    } else {
      console.log('  · 跳过 config.json 写入测试（加 --write-config 开启）');
    }

    if (reloadCount === 0) ok('本次未触发 reload' + (quit ? '' : ' —— 符合预期'));
    else ok(`触发 reload ${reloadCount} 次`);
  } finally {
    if (backup !== null) {
      try { fs.writeFileSync(CFG, backup); } catch (e) { fail('还原 config.json 失败: ' + e.message); }
    }
  }

  console.log(failed ? `\n结果：✗ ${failed} 项失败` : '\n结果：✓ 全通过');
  // main.js 排的定时器会一直挂着让 node 不退出（Electron 里无妨，这里必须显式退出）
  process.exit(failed ? 1 : 0);
})();
