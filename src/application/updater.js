// updater.js — git 驱动的更新引擎（不依赖 electron，可单独 node 测试）
// 核心思想：用 git 当 CDN、git pull 当更新协议。
//   - 应用从「release 工作树」加载代码；
//   - 启动时 / 手动检查时 fetch 远程，比对 release HEAD；
//   - 落后则 pull（fetch + reset --hard），再据改动文件判断「无重启热更 / 需重启」。
'use strict';
const { execFile } = require('child_process');
const path = require('path');

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 1024 * 1024 * 16 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = (stderr || '').toString();
        err.stdout = (stdout || '').toString();
        return reject(err);
      }
      resolve((stdout || '').toString().trim());
    });
  });
}

// 解析实际加载代码的目录（appRoot）。
// useWorktree=true：主仓库留在开发分支(master)，另开一个 release 工作树隔离，应用只加载该树。
async function resolveAppTree({ repoPath, branch, useWorktree }) {
  if (!useWorktree) return path.resolve(repoPath);
  const base = path.basename(path.resolve(repoPath));
  const wt = path.join(path.dirname(path.resolve(repoPath)), `${base}.release`);
  try {
    await runGit(['rev-parse', '--is-inside-work-tree'], wt); // 已存在
    await runGit(['checkout', branch], wt).catch(() => {});   // 确保在该分支
    return wt;
  } catch {
    try {
      await runGit(['worktree', 'add', wt, branch], path.resolve(repoPath)); // 首次创建
    } catch {
      // 目录被外部删除但 .git 里残留 worktree 元数据时，add 会拒绝；prune 后重试一次
      await runGit(['worktree', 'prune'], path.resolve(repoPath));
      await runGit(['worktree', 'add', wt, branch], path.resolve(repoPath));
    }
    return wt;
  }
}

async function fetch(remote, { cwd }) {
  await runGit(['fetch', remote, '--prune'], cwd);
}

async function localRef(branch, { cwd }) {
  return runGit(['rev-parse', branch], cwd).catch(() => null);
}
async function remoteRef(remote, branch, { cwd }) {
  return runGit(['rev-parse', `${remote}/${branch}`], cwd).catch(() => null);
}

// 比对本地与远程 release 是否落后
async function compare({ remote, branch, cwd }) {
  const [local, remoteSha] = await Promise.all([
    localRef(branch, { cwd }),
    remoteRef(remote, branch, { cwd }),
  ]);
  if (!remoteSha) return { behind: false, offline: true, local, remote: null };
  if (!local) return { behind: true, local: null, remote: remoteSha };
  return { behind: local !== remoteSha, local, remote: remoteSha, offline: false };
}

// 列出 local..remote 之间变更的文件（用于判定能否无重启热更）
async function diffFiles(local, remoteSha, { cwd }) {
  if (!local || !remoteSha) return [];
  const out = await runGit(['diff', '--name-only', `${local}..${remoteSha}`], cwd).catch(() => '');
  return out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

// 同步到远程分支（用 reset --hard 保证干净，避免本地改动冲突）
async function pull({ remote, branch, cwd }) {
  await runGit(['fetch', remote, branch], cwd);
  await runGit(['reset', '--hard', `${remote}/${branch}`], cwd);
}

async function getVersion({ cwd }) {
  return runGit(['describe', '--tags', '--always'], cwd).catch(() => 'unknown');
}

// 判定改动是否「只动渲染层」：仅 app/ 下文件变化 → 无重启热更；否则需重启
function onlyRendererChanges(files, rendererPrefix = 'app/') {
  if (!files.length) return true;
  return files.every((f) => f.startsWith(rendererPrefix));
}

module.exports = {
  runGit, resolveAppTree, fetch, compare, diffFiles, pull, getVersion, onlyRendererChanges,
};
