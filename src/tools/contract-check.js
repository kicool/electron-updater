// contract-check.js — 契约体检（npm run contract-check）
//
// 目的：让「契约错了」在 CI / pre-commit 就暴露，而不是等到用户端 pull 之后崩掉。
// 三个检查：
//   1. 结构自检    schema / 路径 / 单元冲突 / hot 单元必须在 rendererDir 内
//   2. 覆盖率     全部 tracked 文件是否都登记进了 updateUnits（白名单的前提）
//   3. bridgeApi  注册表声明与 preload.js 实现双向一致（正则解析，不 require electron）
//
// 退出码：0 = 通过；1 = 有 error；2 = 只有 warn 但开了 --strict
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const here = __dirname;
const REG = require('../application/registry');       // 已合并 registry.json + config.json
const core = require('../update-kit/core/contract');

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const quiet = args.includes('--quiet');

const appRoot = path.resolve(REG.repoPath);

function git(args_) {
  return execFileSync('git', args_, { cwd: appRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 });
}

console.log('== 契约体检 ==');
console.log(`  加载树  : ${appRoot}`);
console.log(`  契约版本: ${REG.contractVersion}（minSupported=${REG.contractMinSupported}）`);
console.log(`  更新单元: ${REG.updateUnits.map((u) => u.name + ':' + u.class).join(', ')}`);
console.log('');

// ---- 1) 结构自检 ----
const v = core.validate(REG, { appRoot, shellDir: REG.shellDir });
console.log(`[1] 结构自检: ${v.errors.length ? '✗ ' + v.errors.length + ' error' : '✓ 通过'}` +
  (v.warn.length ? `，${v.warn.length} warn` : ''));
v.errors.forEach((e) => console.log('    ✗ ' + e));
if (!quiet || strict) v.warn.forEach((w) => console.log('    ⚠ ' + w));

// ---- 2) 覆盖率 ----
// 白名单的前提是「所有路径都登记」。tracked 是准发货的，untracked 是刚加还没提交的 ——
// 后者现在不检查，等提交后才发现未登记就晚了，所以一并列出来。
let tracked = [];
let untracked = [];
try {
  tracked = git(['ls-files']).split('\n').map((s) => s.trim()).filter(Boolean);
  untracked = git(['ls-files', '--others', '--exclude-standard'])
    .split('\n').map((s) => s.trim()).filter(Boolean);
} catch (e) {
  console.log('[2] 覆盖率: ✗ 无法枚举文件：' + e.message);
}
const uncovered = core.coverage(tracked, REG.updateUnits);
const uncoveredNew = core.coverage(untracked, REG.updateUnits);
console.log(`[2] 覆盖率 : tracked ${tracked.length} 个 ${uncovered.length ? '✗ ' + uncovered.length + ' 个未登记' : '✓ 全覆盖'}` +
  (untracked.length ? `；未提交 ${untracked.length} 个 ${uncoveredNew.length ? '（其中 ' + uncoveredNew.length + ' 个未登记）' : '✓ 均已登记'}` : ''));
uncovered.forEach((f) => console.log('    · ' + f));
uncoveredNew.forEach((f) => console.log('    · (未提交) ' + f));
if (uncovered.length || uncoveredNew.length) {
  console.log('    → 请把它加进某个 updateUnit，或确认它确实与运行态无关后显式归类');
}

// ---- 3) bridgeApi 双向一致 ----
const preloadSrc = fs.readFileSync(REG.preloadPath, 'utf8');
const b = core.checkBridgeApi(preloadSrc, REG.bridgeApi);
console.log(`[3] bridgeApi: ${b.errors.length ? '✗ ' + b.errors.length + ' error' : '✓ 一致（' + REG.bridgeApi.length + ' 个）'}`);
b.errors.forEach((e) => console.log('    ✗ ' + e));
if (!quiet) console.log(`    声明=[${(b.declared || []).join(', ')}]\n    实现=[${(b.implemented || []).join(', ')}]`);

const errors = v.errors.length + b.errors.length + uncovered.length;
const warns = v.warn.length;
console.log('');
if (errors) {
  console.log(`结果：✗ ${errors} 项未通过`);
  process.exit(1);
}
if (strict && warns) {
  console.log(`结果：⚠ ${warns} 项告警（--strict 下视为失败）`);
  process.exit(2);
}
console.log(`结果：✓ 通过${warns ? `（${warns} 项告警，可忽略）` : ''}`);
