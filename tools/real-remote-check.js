// tools/real-remote-check.js — 验证「真实远程」读取路径（已绑定 kicool/electron-updater）
//
// 本脚本只做【读取】，不涉及 push：
//   - clone 真实 GitHub 仓库（应已含完整应用）
//   - 若仓库为空（零提交）→ 提示先 push 内容或运行 scripts/publish.sh 造一个 release 分支
//   - 否则用 updater 做 fetch/compare/diff，证明真实远程读取路径成立
//
// 运行: npm run selftest  (或 node tools/real-remote-check.js)
// 覆盖仓库: GH_REPO_URL=https://github.com/other/repo.git node tools/real-remote-check.js
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const updater = require('../src/application/updater');

const REPO = process.env.GH_REPO_URL || 'https://github.com/kicool/electron-updater.git';

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-real-'));
  const cwd = path.join(tmp, 'repo');
  console.log('[real] clone 真实仓库:', REPO);
  execSync(`git clone -q --depth 30 ${REPO} ${cwd}`, { stdio: 'ignore' });

  // 判断是否为空仓库（无提交）
  let empty = false;
  try {
    execSync('git rev-parse HEAD', { cwd, stdio: 'ignore' });
  } catch {
    empty = true;
  }

  if (empty) {
    console.log('[real] ✅ 远端可达（clone 成功），但仓库当前为空（零提交）。');
    console.log('[real]    请先在本机 push 内容，或运行: bash scripts/publish.sh ' + REPO);
    console.log('[real]    有 release 分支后本脚本将完整演示 fetch / compare / diff。');
    process.exit(0);
  }

  await updater.fetch('origin', { cwd });
  const cmp = await updater.compare({ remote: 'origin', branch: 'release', cwd });
  console.log('[real] 本地==远端? behind =', cmp.behind,
              '| version =', await updater.getVersion({ cwd }));

  const initSha = execSync('git rev-list --max-parents=0 HEAD', { cwd }).toString().trim().split('\n')[0];
  const headSha = execSync('git rev-parse HEAD', { cwd }).toString().trim();
  const files = await updater.diffFiles(initSha, headSha, { cwd });
  console.log(`[real] 初始提交→HEAD 改动文件数: ${files.length}`, files.slice(0, 5).join(', '));

  console.log('[real] ✅ 真实远程 fetch / compare / diff 读取路径验证通过');
  process.exit(0);
})().catch((e) => { console.error('[real] 失败:', e.stderr || e.message); process.exit(1); });
