// core-selftest.js — core/ 的 node 单测（npm run core-test）
//
// 存在的理由：分类器与策略引擎是纯 node 的，于是「判据」本身可以被测试。
// 判据一旦可被测试，就不会在无人察觉时漂移（设计文档第 8 节第 4 项）。
'use strict';
const classifier = require('../update-kit/core/classifier');
const policy = require('../update-kit/core/policy');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + '\n      ' + e.message);
  }
}
function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what} 期望 ${b}，实际 ${a}`);
}

// 与 registry.json 保持同构的最小白名单（避免测试依赖配置文件，便于 CI 独立跑）
const UNITS = [
  { name: 'renderer', class: 'hot', paths: ['src/application/renderer/'], action: 'reload' },
  { name: 'shell', class: 'restart', paths: ['src/application/main.js', 'src/application/preload.js', 'src/update-kit/'], action: 'relaunch' },
  { name: 'deps', class: 'restart', paths: ['package.json', 'package-lock.json'], action: 'npm-ci-then-relaunch', fallback: 'reinstall' },
  { name: 'runtime', class: 'reinstall', paths: ['node_modules/'], action: 'prompt-reinstall', unreachableByGit: true },
  { name: 'docs', class: 'none', paths: ['docs/', 'README.md'], action: 'none' },
  { name: 'tools', class: 'none', paths: ['src/tools/'], action: 'none' },
];

console.log('== classifier: 匹配规则 ==');
t('目录前缀命中', () => eq(classifier.matchUnit('src/application/renderer/renderer.js', UNITS).name, 'renderer'));
t('精确文件命中', () => eq(classifier.matchUnit('package.json', UNITS).name, 'deps'));
t('最长前缀优先：update-kit 覆盖更粗的单元', () => {
  const units = UNITS.concat([{ name: 'src', class: 'none', paths: ['src/'], action: 'none' }]);
  eq(classifier.matchUnit('src/update-kit/core/policy.js', units).name, 'shell');
});
t('未登记返回 null', () => eq(classifier.matchUnit('随便一个/未登记.js', UNITS), null));

console.log('\n== classifier: 分类（含已实证的误报场景）==');
t('只改 docs → none（修复 1f4fdd0..547b7d4 的「需重启」误报）', () => {
  const r = classifier.classify(['docs/IMPLEMENTATION.md', 'docs/build.md'], { units: UNITS });
  eq(r.klass, 'none');
  eq(r.needsRestart, false);
  eq(r.unknown.length, 0);
});
t('只改 renderer → hot', () => {
  const r = classifier.classify(['src/application/renderer/renderer.js'], { units: UNITS });
  eq(r.klass, 'hot');
  eq(r.action, 'reload');
});
t('renderer + docs 混合 → 取最高档 hot（docs 不打扰）', () => {
  const r = classifier.classify(['src/application/renderer/index.html', 'README.md'], { units: UNITS });
  eq(r.klass, 'hot');
});
t('改 preload → restart', () => {
  const r = classifier.classify(['src/application/preload.js'], { units: UNITS });
  eq(r.klass, 'restart');
});
t('改 package.json → restart 且动作是 npm-ci-then-relaunch', () => {
  const r = classifier.classify(['package.json'], { units: UNITS });
  eq(r.klass, 'restart');
  eq(r.action, 'npm-ci-then-relaunch');
  eq(r.units[0].fallback, 'reinstall');
});
t('未登记路径 → restart + 告警（不静默）', () => {
  const r = classifier.classify(['src/new-dir/foo.js'], { units: UNITS });
  eq(r.klass, 'restart');
  eq(r.unknown.length, 1);
  if (!r.warnings.join('').includes('未登记')) throw new Error('缺告警');
});
t('bridgeApi 变化 → hot 降级为 restart', () => {
  const r = classifier.classify(['src/application/renderer/renderer.js'], { units: UNITS, contractChanged: true });
  eq(r.klass, 'restart');
});
t('契约主版本跳跃 → reinstall（无法自举）', () => {
  const r = classifier.classify(['src/application/renderer/renderer.js'], {
    units: UNITS, runningContract: '1.1.0', targetContract: '2.0.0', minSupported: '1.0.0',
  });
  eq(r.klass, 'reinstall');
  eq(r.action, 'prompt-reinstall');
});
t('契约次版本变化 → restart', () => {
  const r = classifier.classify(['src/application/renderer/renderer.js'], {
    units: UNITS, runningContract: '1.0.0', targetContract: '1.1.0', minSupported: '1.0.0',
  });
  eq(r.klass, 'restart');
});
t('契约降至 minSupported 以下 → reinstall', () => {
  eq(classifier.compareContract('1.1.0', '0.9.0', '1.0.0'), 'incompatible');
});
t('契约修订号变化 → 不影响分类', () => {
  const r = classifier.classify(['src/application/renderer/renderer.js'], {
    units: UNITS, runningContract: '1.1.0', targetContract: '1.1.1', minSupported: '1.0.0',
  });
  eq(r.klass, 'hot');
});

console.log('\n== classifier: 白名单自检 ==');
t('非法 class 报错', () => {
  const e = classifier.validateUnits([{ name: 'x', class: 'maybe', paths: ['a/'] }]);
  if (!e.some((s) => s.includes('非法'))) throw new Error('未报非法 class');
});
t('同路径被两个单元声明 → 冲突报错', () => {
  const e = classifier.validateUnits([
    { name: 'a', class: 'hot', paths: ['src/x/'] },
    { name: 'b', class: 'none', paths: ['src/x/'] },
  ]);
  if (!e.some((s) => s.includes('路径冲突'))) throw new Error('未报冲突');
});
t('绝对路径 / 越界路径被拒', () => {
  const e = classifier.validateUnits([{ name: 'a', class: 'none', paths: ['../outside/'] }]);
  if (!e.some((s) => s.includes('仓库内相对路径'))) throw new Error('未报越界');
});

console.log('\n== policy: 时机判定 ==');
const P = {
  enabled: true, onStartup: 'checkAndApply',
  schedule: { mode: 'interval', intervalMinutes: 60, dailyAt: '09:00', jitterMinutes: 5 },
  quietHours: { from: '23:00', to: '07:00' },
  apply: 'auto',
  constraints: { skipWhenDirty: true, maxRetries: 3, backoffMinutes: [5, 15, 60] },
};
const noon = new Date('2026-09-30T12:00:00').getTime();
const night = new Date('2026-09-30T23:30:00').getTime();

t('总开关关闭 → 不检测', () => eq(policy.shouldCheck({ ...P, enabled: false }, noon, {}).check, false));
t('schedule.mode=off → 不检测', () => eq(policy.shouldCheck({ ...P, schedule: { mode: 'off' } }, noon, {}).check, false));
t('免打扰时段内 → 不检测', () => {
  const r = policy.shouldCheck(P, night, {});
  eq(r.check, false);
  if (!r.reason.includes('免打扰')) throw new Error('原因应为免打扰，实际：' + r.reason);
});
t('距上次检测不足一个 interval → 不检测', () => {
  const r = policy.shouldCheck(P, noon, { lastCheckAt: noon - 10 * policy.MINUTE });
  eq(r.check, false);
});
t('距上次检测超过一个 interval → 检测', () => {
  const r = policy.shouldCheck(P, noon, { lastCheckAt: noon - 61 * policy.MINUTE }, () => 0.5); // jitter=0
  eq(r.check, true);
});
t('jitter 在 ±jitterMinutes 内', () => {
  const j = policy.jitterMs(5, () => 0); // rand=0 → -5min
  eq(j, -5 * policy.MINUTE);
  const j2 = policy.jitterMs(5, () => 0.999999); // → 接近 +5min
  if (j2 > 5 * policy.MINUTE || j2 < 4 * policy.MINUTE) throw new Error('上界异常: ' + j2);
});
t('dailyAt：今天 09:00 已过 → 排到明天', () => {
  const at = policy.nextCheckAt({ ...P, schedule: { mode: 'dailyAt', dailyAt: '09:00', jitterMinutes: 0 } },
    noon, {}, () => 0.5);
  const d = new Date(at);
  eq([d.getDate(), d.getHours()], [1, 9]); // 2026-09-30 12:00 之后的下个 09:00 = 10-01 09:00
});
t('连续失败 → 退避（第 1 次 5 分钟）', () => {
  const d = policy.nextDelayMs(P, noon, { lastCheckAt: noon, failures: 1 }, () => 0.5);
  eq(d, 5 * policy.MINUTE);
});
t('连续失败达 maxRetries → 本轮放弃（null）', () => {
  eq(policy.nextDelayMs(P, noon, { lastCheckAt: noon, failures: 3 }, () => 0.5), null);
});
t('apply=notify → 不自动应用', () => eq(policy.shouldApply({ ...P, apply: 'notify' }, { klass: 'hot' }), false));
t('dirty → 不自动应用（自动更新无人值守，比手动更危险）', () => eq(policy.shouldApply(P, { klass: 'hot', dirty: true }), false));
t('正常 hot → 自动应用', () => eq(policy.shouldApply(P, { klass: 'hot' }), true));
t('onStartup 解析（总开关关闭时为 off）', () => {
  eq(policy.startupMode({ ...P, enabled: false }), 'off');
  eq(policy.startupMode(P), 'checkAndApply');
});

console.log('\n== policy: 界面改配置（深合并，不能抹掉兄弟字段）==');
t('只改 enabled，schedule/quietHours 保留', () => {
  const r = policy.mergePolicy(P, { enabled: false });
  eq(r.enabled, false);
  eq(r.schedule.intervalMinutes, 60);
  eq(r.quietHours.from, '23:00');
});
t('只改 schedule.mode，intervalMinutes 不丢', () => {
  const r = policy.mergePolicy(P, { schedule: { mode: 'dailyAt' } });
  eq(r.schedule.mode, 'dailyAt');
  eq(r.schedule.intervalMinutes, 60); // 兄弟字段保留
  eq(r.schedule.dailyAt, '09:00');
});
t('改 intervalMinutes 后仍可被校验器接受', () => {
  const r = policy.mergePolicy(P, { schedule: { intervalMinutes: 15 } });
  const e = require('../update-kit/core/contract').validate(
    { paths: { rendererDir: 'src/application/renderer', appEntry: 'src/application/renderer/index.html' },
      updateUnits: UNITS, updatePolicy: r },
    {});
  eq(e.errors, []);
});

console.log('\n== policy: 坏配置不得伤害远程（组合矩阵暴露后修复，反向校准锁死）==');
t('intervalMinutes=1 → 抬到 5 分钟下限', () => {
  eq(policy.intervalMs({ mode: 'interval', intervalMinutes: 1 }), 5 * policy.MINUTE);
});
t('intervalMinutes=0 / -10 / NaN → 回落 60 分钟（不是 1 秒一次 fetch）', () => {
  for (const bad of [0, -10, NaN, undefined]) {
    eq(policy.intervalMs({ mode: 'interval', intervalMinutes: bad }), 60 * policy.MINUTE,
      `intervalMinutes=${bad}`);
  }
});
t('排下一次检测永远 ≥5 分钟后（除非已逾期）', () => {
  const now = noon;
  const p = { ...P, schedule: { mode: 'interval', intervalMinutes: 1, jitterMinutes: 0 } };
  const at = policy.nextScheduledAt(p, now, { lastCheckAt: now }, () => 0.5);
  if (at - now < 5 * policy.MINUTE) throw new Error('间隔被压到 5 分钟以内: ' + (at - now));
});
t('maxRetries=0 且尚未失败 → 仍安排（修复前 0≥0 会静默永不检测）', () => {
  const p = { ...P, constraints: { ...P.constraints, maxRetries: 0 } };
  if (policy.nextDelayMs(p, noon, { lastCheckAt: noon, failures: 0 }, () => 0.5) === null) {
    throw new Error('未失败却被判放弃');
  }
});
t('maxRetries=0 且已失败 1 次 → 放弃（0 表示一次都不重试）', () => {
  const p = { ...P, constraints: { ...P.constraints, maxRetries: 0 } };
  eq(policy.nextDelayMs(p, noon, { lastCheckAt: noon, failures: 1 }, () => 0.5), null);
});

console.log('\n== contract: 坏配置要被拦在写配置的人面前 ==');
const contract = require('../update-kit/core/contract');
const baseForCheck = () => ({
  paths: { rendererDir: 'src/application/renderer', appEntry: 'src/application/renderer/index.html' },
  updateUnits: UNITS,
  updatePolicy: {
    enabled: true, onStartup: 'check', schedule: { mode: 'interval', intervalMinutes: 60, jitterMinutes: 5 },
    quietHours: { from: '23:00', to: '07:00' }, apply: 'auto',
    constraints: { skipWhenDirty: true, maxRetries: 3, backoffMinutes: [5, 15, 60] },
  },
  contractVersion: '1.1.0',
});
const errsOf = (mut) => {
  const c = baseForCheck();
  mut(c);
  return contract.validate(c, {});
};
t('intervalMinutes=0 → 报错（会高频打远程）', () => {
  const r = errsOf((c) => { c.updatePolicy.schedule.intervalMinutes = 0; });
  if (!r.errors.some((s) => s.includes('intervalMinutes'))) throw new Error('未拦截: ' + r.errors.join('|'));
});
t('intervalMinutes=2 → 报错（低于 5 分钟）', () => {
  const r = errsOf((c) => { c.updatePolicy.schedule.intervalMinutes = 2; });
  if (!r.errors.some((s) => s.includes('过小'))) throw new Error('未拦截: ' + r.errors.join('|'));
});
t('quietHours 只写 from → 报错（免打扰会静默失效）', () => {
  const r = errsOf((c) => { c.updatePolicy.quietHours = { from: '23:00' }; });
  if (!r.errors.some((s) => s.includes('静默失效'))) throw new Error('未拦截: ' + r.errors.join('|'));
});
t('quietHours 起止相同 → 警告（区间为空，永不生效）', () => {
  const r = errsOf((c) => { c.updatePolicy.quietHours = { from: '12:00', to: '12:00' }; });
  if (!r.warn.some((s) => s.includes('永不生效'))) throw new Error('未告警: ' + r.warn.join('|'));
});
t('maxRetries=-1 → 报错', () => {
  const r = errsOf((c) => { c.updatePolicy.constraints.maxRetries = -1; });
  if (!r.errors.some((s) => s.includes('maxRetries'))) throw new Error('未拦截: ' + r.errors.join('|'));
});
t('registry 默认配置本身不得有 error', () => eq(errsOf(() => {}).errors, []));

console.log('\n== 界面决策（ui-state.js 纯函数）==');
const uiState = require('../application/renderer/ui-state');
t('总开关永不置灰（关了还能再打开）', () => {
  for (const enabled of [true, false]) {
    for (const skipUpdate of [true, false]) {
      eq(uiState.policyControls({ enabled, skipUpdate }).masterDisabled, false, `enabled=${enabled}`);
    }
  }
});
t('细项置灰只由 enabled 决定，验收档不置灰', () => {
  eq(uiState.policyControls({ enabled: true, skipUpdate: true }).detailsDisabled, false);
  eq(uiState.policyControls({ enabled: false, skipUpdate: false }).detailsDisabled, true);
});
t('验收档给出提示文案（说明「改动会保存、换档后生效」）', () => {
  const n = uiState.policyControls({ enabled: true, skipUpdate: true }).note;
  if (!n.includes('验收档') || !n.includes('config.json')) throw new Error('文案不符: ' + n);
});
t('dirty 时不给「更新」按钮', () => {
  eq(uiState.updateButtonVisible({ apply: 'notify', behind: true, dirty: true }), false);
});
t('apply=notify 且有更新 → 给按钮', () => {
  eq(uiState.updateButtonVisible({ apply: 'notify', behind: true, dirty: false }), true);
});
t('apply=auto（自动生效）→ 不给按钮（无需手动这一步）', () => {
  eq(uiState.updateButtonVisible({ apply: 'auto', behind: true, dirty: false }), false);
});
t('废弃的 autoPull 不再参与判定（删干净了，防止复活）', () => {
  eq(uiState.updateButtonVisible({ autoPull: false, apply: 'auto', behind: true, dirty: false }), false);
  eq(uiState.updateButtonVisible({ autoPull: true, apply: 'notify', behind: true, dirty: false }), true);
});

console.log('\n== 界面决策：开机三态（onStartup 曾被二值复选框表达错）==');
t('三值原样映射到下拉框', () => {
  for (const v of ['off', 'check', 'checkAndApply']) {
    const c = uiState.startupControl(v);
    eq(c.value, v);
    eq(c.invalid, false);
  }
});
t('非法值回落 off 并标 invalid（契约校验也会报错，双保险）', () => {
  const c = uiState.startupControl('always');
  eq(c.value, 'off');
  eq(c.invalid, true);
});
t('off 不再被显示成「已勾选」——下拉能表达「开机完全不检查」', () => {
  // 曾经：复选框把 off 显示成未勾选，而未勾选写回 check → off 不可表达
  eq(uiState.startupControl('off').value, 'off');
});
t('时机全关（开机 off + 定时 off）→ 必须提示只剩手动（总开关开着也不再自动）', () => {
  const n = uiState.policyControls({ enabled: true, scheduleMode: 'off', onStartup: 'off' }).note;
  if (!n.includes('时机全部关闭')) throw new Error('缺提示: ' + n);
});
t('任一时机开着 → 不出「全关」提示', () => {
  for (const c of [
    { enabled: true, scheduleMode: 'interval', onStartup: 'off' },
    { enabled: true, scheduleMode: 'off', onStartup: 'check' },
  ]) {
    const r = uiState.policyControls(c);
    if (r.noteVisible) throw new Error('不该有提示: ' + r.note);
  }
});

console.log('\n== 旧字段迁移：autoPull → updatePolicy.apply ==');
const registry = require('../application/registry');
t('autoPull=false 且未显式设 apply → 迁移为 notify（保住用户「只提示」的原意）', () => {
  eq(registry.legacyApplyFrom({ autoPull: false }), 'notify');
});
t('autoPull=false 但已显式设 apply → 以新字段为准，不迁移', () => {
  eq(registry.legacyApplyFrom({ autoPull: false, updatePolicy: { apply: 'auto' } }), null);
});
t('没有 autoPull 或 autoPull=true → 不迁移', () => {
  eq(registry.legacyApplyFrom({}), null);
  eq(registry.legacyApplyFrom({ autoPull: true }), null);
});
t('生效策略里不再有 autoPull 字段', () => {
  if ('autoPull' in registry) throw new Error('registry 仍导出 autoPull（死字段会继续误导界面）');
  eq(['auto', 'notify'].includes(registry.updatePolicy.apply), true, 'apply=' + registry.updatePolicy.apply);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
