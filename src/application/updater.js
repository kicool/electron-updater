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

// 「1 份化」后的硬保护：pull 现在作用于用户自己的工作目录本身，
// reset --hard 会抹掉未提交的 tracked 改动 —— 所以拉之前必须先查。
// 只看 tracked（-uno）：untracked 文件不会被 reset --hard 删除，拦它属于过度保护
// （用户自己的数据文件、日志放在仓库里不该让更新失败）。
async function isDirty({ cwd }) {
  const out = await runGit(['status', '--porcelain', '--untracked-files=no'], cwd)
    .catch(() => null);
  if (out === null) return { dirty: false, error: 'git status 执行失败' };
  const files = out.split('\n').map((s) => s.trim()).filter(Boolean);
  return { dirty: files.length > 0, count: files.length, files: files.slice(0, 8) };
}

async function getVersion({ cwd }) {
  return runGit(['describe', '--tags', '--always'], cwd).catch(() => 'unknown');
}

// 检查本地与远程的领先/落后关系
// ahead > 0：本地有未推送的 commit（reset --hard 会丢弃）
// behind > 0：远程有未拉取的 commit
// ahead > 0 且 behind > 0：分叉
async function aheadBehind({ remote, branch, cwd }) {
  const out = await runGit(['rev-list', '--left-right', '--count', `HEAD...${remote}/${branch}`], cwd)
    .catch(() => null);
  if (!out) return { ahead: 0, behind: 0, error: 'git rev-list 执行失败' };
  const [ahead, behind] = out.split('\t').map(Number);
  return { ahead, behind };
}

// 注：「改动是否只动渲染层」的判定已从本文件移除，改由
//   src/update-kit/core/classifier.js 的 classify() 基于 updateUnits 白名单判定。
// 旧实现 onlyRendererChanges() 是路径前缀启发式，会误报（改 docs 也判「需重启」，已实证），
// 已删除以免留下第二套判据。
module.exports = {
  runGit, resolveAppTree, fetch, compare, diffFiles, pull, getVersion, isDirty, aheadBehind,
};
