// main.js — 启动器（主进程）
// 职责：解析加载树 → 按 updatePolicy 决定「启动时 / 定时 / 手动」三种时机下做什么 →
//       拉到更新后由白名单分类器判定 hot(热更) / restart(重启) / reinstall(重装) / none(无影响)。
'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const updater = require('./updater');
const classifier = require('../update-kit/core/classifier');
const upolicy = require('../update-kit/core/policy');

// CONFIG = 契约注册表：所有路径 / 开关 / 更新单元白名单 / bridge API 名单的唯一来源（见 registry.js）
const CONFIG = require('./registry');

let win = null;
let appRoot = null;
let lastStatus = null; // 缓存最近一次 checkUpdate 结果，reload/启动后直接复用，避免二次 fetch 造成「初始化…」空窗
let envInfo = null;    // 环境抬头：回答「我现在加载的是哪棵树、哪个路径」（验收的第一判据）

// 时机策略：CONFIG.updatePolicy 是默认值，用户通过界面改的落在本机 config.json 里覆盖它。
// 注意 updateUnits（白名单）不开放本机覆盖 —— 那是团队契约，不能在本机偷偷放宽。
let POLICY = CONFIG.updatePolicy;

// 运行时状态：必须写 userData，绝不能写仓库里。
// 写仓库会被 reset --hard 抹掉，还会让 isDirty() 永久为真 → 自动更新从此彻底失效。
let userDataDir = null;
let STATE = { lastCheckAt: 0, failures: 0, lastResult: null };
const SCHEDULE = { nextAt: null };
let timer = null;

const stateFile = () => path.join(userDataDir || app.getPath('userData'), 'update-state.json');
function loadState() {
  try { return { ...STATE, ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) }; }
  catch { return { ...STATE }; }
}
function saveState() {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(STATE, null, 2));
  } catch (e) { console.error('[main] 保存更新状态失败:', e.message); }
}

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
  const errs = require('../update-kit/core/contract').validate(CONFIG, { appRoot, shellDir: CONFIG.shellDir }).errors;
  if (errs.length) throw new Error('契约自检未通过：\n  ' + errs.join('\n  '));
  console.log('[contract]\n  ' + CONFIG.describe());
}

// 契约文件相对「加载树」的路径 —— 用于拉取前先读出目标版本的 contractVersion。
// 取不到（比如壳在树外）就返回 null，此时跳过契约兼容性判定，不阻断流程。
function contractRelPath() {
  const rel = path.relative(appRoot, path.join(CONFIG.shellDir, 'registry.json')).replace(/\\/g, '/');
  return rel.startsWith('..') ? null : rel;
}

// 采集「环境抬头」：让界面能自证加载的是哪棵树、根在哪、入口相对根是什么。
// 验收时第一件事就是看这个 —— 否则改了 A 树、看的却是 B 树，效果对了也是白验。
async function collectEnv() {
  const git = (args) => updater.runGit(args, appRoot).catch(() => null); // runGit 第二参是裸 cwd 字符串，不能传对象
  const [head, ref] = await Promise.all([
    git(['rev-parse', '--short', 'HEAD']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);
  // preload 相对「加载树」的路径：正常应落在树内；出现 ../ 说明它来自运行中的壳，
  // 也就是「pull 后 renderer 是新的、preload 仍是旧的」那个洞的物理位置——抬头要把它显式标出来。
  const preloadRel = path.relative(appRoot, CONFIG.preloadPath).replace(/\\/g, '/');
  const preloadOutside = preloadRel.startsWith('..');
  return {
    tree: CONFIG.treeLabel || path.basename(appRoot),  // 未设 treeLabel 时退化为目录名
    root: appRoot,                                     // 根目录绝对路径
    entry: CONFIG.appEntry,                            // 入口相对根目录的路径
    preload: preloadOutside ? preloadRel + '（树外 · 改动需重启生效）' : preloadRel,
    branch: CONFIG.branch,                             // 跟哪个分支比对
    head: head || 'unknown',
    ref: !ref ? 'unknown' : (ref === 'HEAD' ? 'detached' : ref),
    contractVersion: CONFIG.contractVersion,
  };
}

// 拉取【之前】先算清楚这次更新属于哪一档能力：diff 依赖 local..remote，pull 之后就取不到了。
async function classifyPending(cmp) {
  const files = await updater.diffFiles(cmp.local, cmp.remote, { cwd: appRoot });
  let targetContract = null;
  let contractChanged = false;
  const rel = contractRelPath();
  if (rel) {
    try {
      const target = JSON.parse(await updater.runGit(['show', `${cmp.remote}:${rel}`], appRoot));
      targetContract = target.contractVersion || null;
      const a = (target.bridgeApi || []).slice().sort().join(',');
      const b = CONFIG.bridgeApi.slice().sort().join(',');
      contractChanged = a !== b; // bridgeApi 变了 → 旧 preload 可能缺新方法，hot 不成立
    } catch {
      // 读不到目标契约就当不知道（不阻断），分类器会退化为「只看路径」
    }
  }
  const plan = classifier.classify(files, {
    units: CONFIG.updateUnits,
    contractChanged,
    runningContract: CONFIG.contractVersion,
    targetContract,
    minSupported: CONFIG.contractMinSupported,
  });
  plan.targetContract = targetContract;
  return plan;
}

/**
 * 检测 + （可选）拉取 + 分类。
 * @param {object|boolean} opts  true/兼容旧写法 = 只传 pull；推荐 { pull, mode }
 */
async function checkUpdate(opts = {}) {
  const o = typeof opts === 'boolean' ? { pull: opts } : opts;
  const doPull = o.pull !== false;
  const mode = o.mode || 'manual';

  // 验收模式（skipUpdate）：完全不访问远程，只报本地当前版本。
  // 没有它，V1 档在网络不通或很慢时会被 fetch 卡住 —— 而 createWindow 排在 checkUpdate 之后，
  // 结果是连窗口都出不来（[contract] 打印完就没动静了）。
  if (CONFIG.skipUpdate) {
    const version = await updater.getVersion({ cwd: appRoot });
    return { ok: true, updated: false, behind: false, offline: false, skipped: true, version, mode };
  }
  try {
    await updater.fetch(CONFIG.remote, { cwd: appRoot });
  } catch (e) {
    return { ok: false, offline: true, error: String(e.stderr || e.message), mode };
  }
  const cmp = await updater.compare({ remote: CONFIG.remote, branch: CONFIG.branch, cwd: appRoot });
  const version = await updater.getVersion({ cwd: appRoot });

  if (cmp.offline) return { ok: false, offline: true, version, mode };
  if (!cmp.behind) return { ok: true, updated: false, behind: false, version, offline: false, mode };

  if (!doPull) return { ok: true, updated: false, behind: true, version, offline: false, mode };

  // 1 份化后的硬保护：pull 作用于用户自己的工作目录，reset --hard 会抹掉未提交的改动。
  // 有改动就拒绝自动拉取并显式回报，而不是默默毁掉用户的东西。
  const dirty = await updater.isDirty({ cwd: appRoot });
  if (dirty.dirty) {
    console.log(`[main] 检测到 ${dirty.count} 个未提交改动，拒绝自动拉取：\n  ${dirty.files.join('\n  ')}`);
    return {
      ok: true, updated: false, behind: true, version, offline: false, mode,
      dirty: true, dirtyCount: dirty.count, dirtyFiles: dirty.files,
    };
  }

  // D2/D4：检查本地是否领先远程（未推送的 commit）
  // reset --hard 会丢弃未推送的 commit，所以 ahead > 0 时拒绝自动拉取
  const { ahead, behind } = await updater.aheadBehind({ remote: CONFIG.remote, branch: CONFIG.branch, cwd: appRoot });
  if (ahead > 0) {
    console.log(`[main] 本地领先 ${ahead} 个 commit，拒绝自动拉取（避免丢失未推送的提交）`);
    return {
      ok: true, updated: false, behind: true, version, offline: false, mode,
      blocked: 'ahead', aheadCount: ahead, behindCount: behind,
    };
  }

  const plan = await classifyPending(cmp);
  console.log(`[main] 更新分类: klass=${plan.klass} action=${plan.action}` +
    (plan.targetContract ? ` 契约 ${CONFIG.contractVersion}→${plan.targetContract}` : ''));
  plan.warnings.forEach((w) => console.warn('[main][warn] ' + w));

  // deps 单元：action=npm-ci-then-relaunch。默认不自动跑 npm ci（耗时且可能失败，待实测），
  // 只把它标出来；开启 constraints.autoNpmCi 后才真正执行，失败则按 fallback 升级为 reinstall。
  const needNpmCi = plan.units.some((u) => u.action === 'npm-ci-then-relaunch');

  await updater.pull({ remote: CONFIG.remote, branch: CONFIG.branch, cwd: appRoot });

  // npm ci 必须在 pull 之后执行，否则装的是旧 lockfile 的依赖
  if (needNpmCi && POLICY.constraints && POLICY.constraints.autoNpmCi) {
    const r = await runNpmCi();
    if (!r.ok) {
      plan.klass = 'reinstall';
      plan.needsRestart = true;
      plan.reasons.push(`npm ci 失败，按 fallback 升级为 reinstall：${r.error}`);
    } else {
      plan.reasons.push('npm ci 成功，deps 单元降级为 relaunch');
    }
  }
  const newVersion = await updater.getVersion({ cwd: appRoot });
  envInfo = await collectEnv(); // pull 后 HEAD 变了，抬头要跟着更新
  return {
    ok: true, updated: true, behind: false, mode,
    version: newVersion, prevVersion: version,
    files: plan.files, plan,
    klass: plan.klass,
    onlyRenderer: plan.klass === 'hot',   // 兼容渲染层旧字段
    needsRestart: plan.needsRestart,
    offline: false,
  };
}

function runNpmCi() {
  const timeoutMs = (POLICY.constraints && POLICY.constraints.npmCiTimeoutMs) || 300000;
  return new Promise((resolve) => {
    execFile('npm', ['ci'], { cwd: appRoot, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 8 },
      (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: String((stderr || err.message)).split('\n').slice(-3).join(' ') });
        resolve({ ok: true });
      });
  });
}

// 统一下发运行环境 + 时机策略 + 调度状态；reload / pull / 改策略之后都要再发一次
function sendConfig() {
  if (!win) return;
  win.webContents.send('update:config', {
    skipUpdate: CONFIG.skipUpdate, // 验收档：true 时界面要把开关置灰并说明，否则显示「已启用」是假象
    env: envInfo,
    policy: POLICY,
    schedule: { nextAt: SCHEDULE.nextAt, lastCheckAt: STATE.lastCheckAt, failures: STATE.failures },
    units: CONFIG.updateUnits, // 白名单只读下发，供界面展示「每类路径属于哪种更新能力」
  });
}

// 拉到更新后「要不要立刻生效」：hot → reload；restart/reinstall → 只提示，不擅自打断用户。
// apply=notify 时连 hot 都不自动 reload —— 把打断权交还用户。
function applyIfPossible(s) {
  if (!s || !s.ok || !s.updated) return;
  if (POLICY.apply === 'notify') return;
  if (s.klass === 'hot' && win) win.webContents.reload();
}

// 按 updatePolicy 排下一次定时检测（jitter / 免打扰 / 失败退避都在 core/policy.js 里）
function scheduleNext() {
  if (timer) { clearTimeout(timer); timer = null; }
  const now = Date.now();
  const delay = upolicy.nextDelayMs(POLICY, now, STATE);
  SCHEDULE.nextAt = delay === null ? null : now + delay;
  if (delay !== null) timer = setTimeout(runScheduledCheck, delay);
  sendConfig();
}

async function runScheduledCheck() {
  const now = Date.now();
  const decision = upolicy.shouldCheck(POLICY, now, STATE);
  if (!decision.check) { scheduleNext(); return; }
  try {
    const s = await checkUpdate({ pull: upolicy.shouldApply(POLICY, {}), mode: 'scheduled' });
    lastStatus = s;
    STATE.lastCheckAt = now;
    STATE.failures = s.ok ? 0 : STATE.failures + 1;
    saveState();
    if (win) win.webContents.send('update:status', s);
    applyIfPossible(s);
  } catch (e) {
    console.error('[main] 定时检测失败:', e.message);
    STATE.lastCheckAt = now;
    STATE.failures += 1;
    saveState();
  }
  scheduleNext();
}

function createWindow() {
  win = new BrowserWindow({
    width: 920, height: 760,
    webPreferences: {
      preload: CONFIG.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // preload 必须 require('./registry') 读契约注册表 —— 沙箱化 preload 只允许
      // require electron/events/timers/url，本地文件模块一律抛错。实测现象：preload
      // 静默挂掉，renderer 里 window.api 为 undefined。内部原型、源码运行，关沙箱
      // 是本方案的显式前提，不是疏忽。
      sandbox: false,
    },
  });
  win.loadFile(path.join(appRoot, CONFIG.appEntry));
  // 渲染进程报错转发到启动终端（npm start 可见），排障用
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) console.log('[renderer]', msg);
  });
  win.webContents.on('did-finish-load', async () => {
    try {
      // 启动或热更 reload 后，状态已由「whenReady 的启动检测」或「上次手动检查」得出，
      // 直接复用 lastStatus，避免再发一次网络 fetch（否则 reload 后会出现「初始化…」空窗）。
      const status = lastStatus || await checkUpdate({ pull: false, mode: 'manual' });
      if (win) {
        win.webContents.send('update:status', status);
        sendConfig();
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
    userDataDir = app.getPath('userData');
    STATE = loadState();
    envInfo = await collectEnv();
  } catch (e) {
    console.error('[main] ' + e.message);
    dialog.showErrorBox('启动失败：契约校验未通过', e.message);
    app.quit();
    return;
  }

  // 启动那一次的行为由 updatePolicy.onStartup 决定：off / check（只比对）/ checkAndApply
  const mode = upolicy.startupMode(POLICY);
  if (mode === 'off') {
    lastStatus = {
      ok: true, updated: false, behind: false, offline: false, skipped: true, mode: 'startup',
      version: await updater.getVersion({ cwd: appRoot }),
      reason: '自动更新已关闭（updatePolicy.enabled=false 或 onStartup=off）',
    };
  } else {
    lastStatus = await checkUpdate({
      pull: mode === 'checkAndApply' && upolicy.shouldApply(POLICY, {}),
      mode: 'startup',
    });
    STATE.lastCheckAt = Date.now();
    STATE.failures = lastStatus.ok ? 0 : STATE.failures + 1;
    saveState();
  }

  createWindow();
  scheduleNext(); // 排下一次定时检测（enabled=false 或 mode=off 时不会排）

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// 手动检查更新（渲染层按钮触发）。
// apply=auto：落后于远程则直接拉取，hot 时自动 reload（无重启热更）。
// apply=notify：只比对、不拉取，由渲染层展示「更新」按钮让用户手动触发。
ipcMain.handle('check-update', async () => {
  const s = await checkUpdate({ pull: upolicy.shouldApply(POLICY, {}), mode: 'manual' });
  lastStatus = s; // 缓存，reload 后 did-finish-load 直接复用，不再二次 fetch
  applyIfPossible(s);
  sendConfig();
  return s;
});

// 手动触发实际拉取（notify 模式下「更新」按钮调用；或用户想手动 pull）
ipcMain.handle('apply-update', async () => {
  const s = await checkUpdate({ pull: true, mode: 'manual' });
  lastStatus = s;
  applyIfPossible(s);
  sendConfig();
  return s;
});
// 重启应用以应用主进程/preload/依赖更新
ipcMain.on('relaunch', () => { app.relaunch(); app.quit(); });

// 界面改自动更新设置 → 写本机 config.json（gitignore，不会让 isDirty 为真）→ 立刻重排定时器
ipcMain.handle('set-update-policy', async (_e, patch) => {
  if (!patch || typeof patch !== 'object') return { ok: false, error: 'patch 必须是对象' };
  const cfgPath = path.join(CONFIG.shellDir, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { cfg = {}; }
  cfg.updatePolicy = upolicy.mergePolicy(cfg.updatePolicy || {}, patch);
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  } catch (e) {
    return { ok: false, error: '写 config.json 失败: ' + e.message };
  }
  POLICY = upolicy.mergePolicy(CONFIG.updatePolicy, cfg.updatePolicy);
  console.log('[main] 更新策略已变更: ' + JSON.stringify(cfg.updatePolicy));
  scheduleNext();
  return { ok: true, policy: POLICY };
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
