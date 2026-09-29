// registry.js — 契约注册表：本项目所有「路径 / API 名单」的唯一事实源
//
// 分层：
//   registry.json（进 git，静态默认值）  ← 改这里等于改契约，需要评审
//   config.json  （gitignore，机器相关）  ← 只放本机差异：repoPath / branch / autoPull
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
  autoPull: pick('autoPull', registry.autoPull),
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

  describe() {
    return [
      `remote=${this.remote} branch=${this.branch} autoPull=${this.autoPull}`,
      `repoPath=${this.repoPath}`,
      `appEntry=${this.appEntry}`,
      `rendererPrefix=${this.rendererPrefix}`,
      `preload=${this.preloadPath}`,
      `bridgeApi=[${this.bridgeApi.join(', ')}]`,
    ].join('\n  ');
  },
};
