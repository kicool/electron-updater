// registry.js — 契约注册表：本项目所有「路径 / API 名单」的唯一事实源
//
// 分层：
//   registry.json（进 git，静态默认值）  ← 改这里等于改契约，需要评审
//   config.json  （gitignore，机器相关）  ← 只放本机差异：repoPath / branch / updatePolicy
//   registry.js  （本文件）               ← 合并两者，解析成绝对路径并导出
//
// 两个根目录要分清（很容易踩）：
//   shellDir = src/application/…  壳自身所在目录   → preload 相对它解析
//   repoRoot = appRoot            代码树根目录     → appEntry / rendererDir 相对它解析
//   （二者在同一仓库里布局一致，但语义不同，别混用）
'use strict';
const fs = require('fs');
const path = require('path');

const shellDir = __dirname;
const registryFile = path.join(shellDir, 'registry.json');
const localConfigFile = path.join(shellDir, 'config.json');

function readJson(file, required) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (required) throw new Error(`[registry] 读取契约注册表失败: ${file}（${e.message}）`);
    return null;
  }
}

const registry = readJson(registryFile, true);
const override = readJson(localConfigFile) || {};

function pick(key, fallback) {
  return override[key] !== undefined ? override[key] : fallback;
}

// updatePolicy 允许本机覆盖且需要深合并（用户可能只改 enabled，不能把 schedule 抹掉）；
// updateUnits 是团队契约，不开放本机覆盖 —— 谁都不能在本机偷偷放宽更新类别。
function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const nested = v && typeof v === 'object' && !Array.isArray(v) &&
      out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]);
    out[k] = nested ? deepMerge(out[k], v) : v;
  }
  return out;
}

// —— 旧字段迁移（2026-09-30）——
// autoPull 是 P1 之前的「自动拉取 / 仅提示」开关，P1 之后统一由 updatePolicy.apply 表达
// （auto/notify）。它当时只影响界面显示、不影响行为，于是出现「抬头写仅提示、实际自动拉取」的假象。
// 删字段时必须做这次迁移：老 config.json 里 autoPull:false 且没显式给 apply 的用户，
// 若直接按默认 apply=auto 跑，会被静默从「只提示」改成「自动拉取并生效」——跟他原本的意图相反。
function legacyApplyFrom(override) {
  if (!override || override.autoPull !== false) return null;
  if (override.updatePolicy && override.updatePolicy.apply !== undefined) return null; // 已显式设定，以新字段为准
  return 'notify';
}

function resolvePolicy() {
  const merged = deepMerge(registry.updatePolicy || {}, override.updatePolicy || {});
  const legacy = legacyApplyFrom(override);
  if (!legacy) return merged;
  console.log('[registry] 迁移旧字段：config.json 的 autoPull=false 已映射为 updatePolicy.apply=notify' +
    '（autoPull 已废弃，请改写为 updatePolicy.apply）');
  return { ...merged, apply: legacy };
}

const paths = { ...registry.paths, ...(override.paths || {}) };

// repoPath：本机覆盖项通常是绝对路径，缺省路径相对 shellDir 解析
const repoPath = path.resolve(shellDir, pick('repoPath', paths.repoPath));

// posix 化并去掉结尾斜杠，保证前缀比较稳定
const norm = (p) => p.replace(/\\/g, '/').replace(/\/$/, '');
const rendererDir = norm(paths.rendererDir);
const appEntry = norm(paths.appEntry);

if (!appEntry.startsWith(rendererDir + '/')) {
  throw new Error(`[registry] 契约冲突：appEntry(${appEntry}) 必须位于 rendererDir(${rendererDir}) 内，` +
    '否则「改动全在渲染层→无重启热更」的判定前提不成立');
}

module.exports = {
  // 运行期开关
  remote: pick('remote', registry.remote),
  branch: pick('branch', registry.branch),
  useWorktree: pick('useWorktree', registry.useWorktree),
  treeLabel: pick('treeLabel', registry.treeLabel),
  // autoPull：已废弃（2026-09-30），语义并入 updatePolicy.apply（auto=自动生效 / notify=只提示）。
  // 仍写着的旧 config.json 会在 resolvePolicy() 里被迁移，不会静默改变用户原本的意图。
  skipUpdate: pick('skipUpdate', registry.skipUpdate),
  autoRestart: pick('autoRestart', registry.autoRestart),

  // 根目录
  shellDir,      // 壳层所在目录（src/application/…）
  repoPath,      // 默认代码树根目录；实际加载目录可能另有 worktree

  // 壳侧路径（相对 shellDir 已解析为绝对路径）
  preloadPath: path.resolve(shellDir, paths.preload),

  // 代码树相对路径（相对 repoRoot，配合 main.js 的 appRoot 使用）
  appEntry,                     // 'src/application/renderer/index.html'
  rendererDir,                  // 'src/application/renderer'
  rendererPrefix: rendererDir + '/',  // 热更判定前缀
  rendererEntry: norm(paths.rendererEntry),

  // 桥接契约：preload 必须实现且仅实现这些 API（本机不可覆盖）
  bridgeApi: registry.bridgeApi.slice(),

  // 契约版本：语义化版本。主版本跳跃 = 运行中的壳读不懂新契约（无法自举）→ reinstall；
  // 次版本变化 = bridgeApi 名单变了 → 保守降为 restart；修订号变化 = 无运行态影响。
  contractVersion: registry.contractVersion || '0.0.0',
  contractMinSupported: registry.contractMinSupported || '0.0.0',

  // 更新单元白名单：所有路径显式登记更新类别（团队契约，本机不可覆盖）
  updateUnits: registry.updateUnits || [],

  // 时机策略：默认值来自 registry.json，本机选择（界面开关）来自 config.json.updatePolicy
  updatePolicy: resolvePolicy(),
  legacyApplyFrom, // 导出供测试：旧字段迁移规则必须可断言，否则删了没人知道对不对

  describe() {
    return [
      `remote=${this.remote} branch=${this.branch} skipUpdate=${this.skipUpdate}`,
      `treeLabel=${this.treeLabel || '(未设置 → 界面按目录名推断)'}`,
      `repoPath=${this.repoPath}`,
      `appEntry=${this.appEntry}`,
      `rendererPrefix=${this.rendererPrefix}`,
      `preload=${this.preloadPath}`,
      `bridgeApi=[${this.bridgeApi.join(', ')}]`,
      `contractVersion=${this.contractVersion} (minSupported=${this.contractMinSupported})`,
      `updateUnits=[${this.updateUnits.map((u) => u.name + ':' + u.class).join(', ')}]`,
      `updatePolicy=enabled:${this.updatePolicy.enabled} onStartup:${this.updatePolicy.onStartup}` +
        ` schedule:${(this.updatePolicy.schedule || {}).mode}` +
        ` apply:${this.updatePolicy.apply}`,
    ].join('\n  ');
  },
};
