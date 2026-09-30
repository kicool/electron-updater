// policy-matrix.js — updatePolicy 的组合矩阵测试（npm run matrix-test）
//
// 为什么需要它：core-selftest 只测「单因子」（单独关开关、单独进免打扰……），
// 但真实配置是这些维度的**笛卡尔积**：enabled × onStartup × schedule.mode ×
// intervalMinutes × dailyAt × apply × quietHours × now × lastCheckAt × failures × dirty。
// 手点 UI 只能覆盖其中十几条，其余全靠脑补 —— 组合冲突正是在没覆盖的那部分里。
//
// 做法：穷举组合；断言不写死每个组合的期望值（写不过来，也容易自证），
// 而是断言**不变量（invariant）**——任何组合都必须成立的性质。
// 不变量 I1..I9 的实现尽量独立重算（不照抄 policy.js 的表达式），避免自证。
'use strict';
const policy = require('../update-kit/core/policy');

const MINUTE = 60 * 1000;
const NO_JITTER = () => 0.5; // rand=0.5 → jitterMs = floor(0.5*2j-j)=0

// ---------- 组合维度 ----------
const DIMS = {
  enabled: [true, false],
  onStartup: ['off', 'check', 'checkAndApply'],
  mode: ['off', 'interval', 'dailyAt'],
  intervalMinutes: [5, 60, 1440],
  dailyAt: ['09:00', '23:30'],
  apply: ['auto', 'notify'],
  quietHours: [
    null,                                  // 不设免打扰
    { from: '23:00', to: '07:00' },        // 跨午夜（默认）
    { from: '09:00', to: '17:00' },        // 同日
    { from: '23:00', to: '23:00' },        // 退化：from === to
  ],
  now: [
    new Date('2026-09-30T12:00:00').getTime(), // 中午
    new Date('2026-09-30T23:30:00').getTime(), // 跨午夜免打扰内
    new Date('2026-09-30T03:00:00').getTime(), // 凌晨（跨午夜免打扰内）
    new Date('2026-09-30T10:00:00').getTime(), // 同日免打扰内
  ],
  lastCheckAt: [null, -10 * MINUTE, -120 * MINUTE], // 相对 now 的偏移；null=从未检测
  failures: [0, 1, 2, 3, 4],
  dirty: [true, false],
};

const CONSTRAINTS = { skipWhenDirty: true, maxRetries: 3, backoffMinutes: [5, 15, 60] };

// ---------- 独立重算（不照抄 policy.js，用于交叉验证） ----------
function minutesOfDayIndependent(ts) {
  const s = new Date(ts).toTimeString().slice(0, 5); // "HH:MM"
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
function inQuietIndependent(q, ts) {
  if (!q || !q.from || !q.to) return false;
  const f = q.from.split(':').map(Number);
  const t = q.to.split(':').map(Number);
  const from = f[0] * 60 + f[1];
  const to = t[0] * 60 + t[1];
  const cur = minutesOfDayIndependent(ts);
  return from <= to ? (cur >= from && cur < to) : (cur >= from || cur < to);
}

// ---------- 不变量 ----------
// 每条返回 null（通过）或违反描述
// 免打扰顺延的独立实现（不复用 policy.quietEndAfter，避免自证）
const quietEndIndependent = (q, ts) => {
  const [h, m] = q.to.split(':').map(Number);
  const d = new Date(ts);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= ts) d.setDate(d.getDate() + 1);
  return d.getTime();
};
// 「这条组合是否走到免打扰/排期判定」——开关关、定时关、重试耗尽时，
// shouldCheck 会提前返回，跟排期无关的不变量不该算它违反
const scheduling = (ctx) => ctx.policy.enabled &&
  ctx.policy.schedule.mode !== 'off' &&
  (ctx.state.failures || 0) < 3;

const INVARIANTS = [
  ['I1 enabled=false ⇒ 全自动路径全关', (ctx) => {
    if (ctx.policy.enabled) return null;
    if (ctx.checkRes.check) return 'shouldCheck 仍为 true';
    if (policy.startupMode(ctx.policy) !== 'off') return 'startupMode 不是 off';
    for (const d of [true, false]) {
      if (policy.shouldApply(ctx.policy, { klass: 'hot', dirty: d })) return 'shouldApply 仍为 true';
    }
    return null;
  }],

  ['I2 schedule.mode=off ⇒ 不安排下次定时', (ctx) => {
    if (ctx.policy.schedule.mode !== 'off') return null;
    if (policy.nextScheduledAt(ctx.policy, ctx.now, ctx.state, NO_JITTER) !== null) return '仍安排了下次检测';
    return null;
  }],

  ['I3 免打扰内 ⇒ 不检测，且顺延到免打扰结束', (ctx) => {
    if (!scheduling(ctx)) return null;
    if (!inQuietIndependent(ctx.policy.quietHours, ctx.now)) return null;
    if (ctx.checkRes.check) return '免打扰内仍判定要检测';
    const expect = quietEndIndependent(ctx.policy.quietHours, ctx.now);
    if (ctx.checkRes.nextAt !== expect) return `nextAt 应为免打扰结束 ${new Date(expect).toISOString()}，` +
      `实际 ${new Date(ctx.checkRes.nextAt).toISOString()}`;
    return null;
  }],

  ['I4 failures ≥ maxRetries ⇒ 本轮放弃（无下次）', (ctx) => {
    if ((ctx.state.failures || 0) < 3) return null;
    if (!ctx.policy.enabled || ctx.policy.schedule.mode === 'off') return null;
    if (policy.nextDelayMs(ctx.policy, ctx.now, ctx.state, NO_JITTER) !== null) return '仍安排了下次检测';
    if (ctx.checkRes.check) return '已达重试上限仍判定要检测';
    return null;
  }],

  ['I5 shouldCheck 与 nextScheduledAt 一致（不许拿截断值判定）', (ctx) => {
    if (!scheduling(ctx)) return null;
    const at = policy.nextScheduledAt(ctx.policy, ctx.now, ctx.state, NO_JITTER);
    if (at === null) {
      return ctx.checkRes.check ? '排期为 null 却判定要检测' : null;
    }
    // 精确规范：此刻在免打扰内 → 一定不检测（顺延）；否则等价于「已到排期时刻」
    const expect = inQuietIndependent(ctx.policy.quietHours, ctx.now) ? false : ctx.now >= at;
    if (ctx.checkRes.check !== expect) {
      return `nextScheduledAt=${new Date(at).toISOString()}、now=${new Date(ctx.now).toISOString()}、` +
        `免打扰=${inQuietIndependent(ctx.policy.quietHours, ctx.now)}，应得 check=${expect}，实际 ${ctx.checkRes.check}`;
    }
    return null;
  }],

  ['I6 0 < failures < maxRetries ⇒ 走退避，而不是 interval', (ctx) => {
    const f = ctx.state.failures || 0;
    if (f <= 0 || f >= 3) return null;
    if (!ctx.policy.enabled || ctx.policy.schedule.mode === 'off') return null;
    const backs = [5, 15, 60];
    const expect = (ctx.state.lastCheckAt || ctx.now) + backs[Math.min(f - 1, 2)] * MINUTE;
    const at = policy.nextScheduledAt(ctx.policy, ctx.now, ctx.state, NO_JITTER);
    if (at !== expect) return `应为退避 ${backs[Math.min(f - 1, 2)]} 分钟 → ${new Date(expect).toISOString()}，` +
      `实际 ${new Date(at).toISOString()}`;
    return null;
  }],

  ['I7 无失败 ⇒ 按 interval / dailyAt 排期（落进免打扰则顺延）', (ctx) => {
    if (!scheduling(ctx)) return null;
    if ((ctx.state.failures || 0) > 0) return null;
    const base = ctx.state.lastCheckAt || ctx.now;
    let at0;
    if (ctx.policy.schedule.mode === 'interval') {
      at0 = base + ctx.policy.schedule.intervalMinutes * MINUTE;
    } else {
      const [h, m] = ctx.policy.schedule.dailyAt.split(':').map(Number);
      const d = new Date(ctx.now);
      d.setHours(h, m, 0, 0);
      if (d.getTime() <= ctx.now) d.setDate(d.getDate() + 1);
      at0 = d.getTime();
    }
    // 独立重算顺延：排期落在免打扰里 → 推到免打扰结束
    const expect = inQuietIndependent(ctx.policy.quietHours, at0)
      ? quietEndIndependent(ctx.policy.quietHours, at0)
      : at0;
    const at = policy.nextScheduledAt(ctx.policy, ctx.now, ctx.state, NO_JITTER);
    if (expect !== at) return `期望 ${new Date(expect).toISOString()}，实际 ${new Date(at).toISOString()}`;
    return null;
  }],

  ['I8 shouldApply 真值表（enabled ∧ apply≠notify ∧ ¬(dirty∧skipWhenDirty)）', (ctx) => {
    const dirty = ctx.dirty;
    const expect = ctx.policy.enabled && ctx.policy.apply !== 'notify' &&
      !(dirty && CONSTRINTS_SKIP_DIRTY(ctx.policy));
    const got = policy.shouldApply(ctx.policy, { klass: 'hot', dirty });
    if (got !== expect) return `apply=${ctx.policy.apply} dirty=${dirty} 期望 ${expect}，实际 ${got}`;
    return null;
  }],

  ['I9 抖动边界：|jitter| ≤ jitterMinutes', (ctx) => {
    const jm = ctx.policy.schedule.jitterMinutes || 0;
    for (const r of [() => 0, () => 0.999999, () => 0.5]) {
      const j = policy.jitterMs(jm, r);
      if (Math.abs(j) > jm * MINUTE) return `抖动 ${j} 超出 ±${jm} 分钟`;
    }
    return null;
  }],

  ['I10 任意组合都不得抛异常（含非法/退化输入）', (ctx) => {
    try {
      policy.shouldCheck(ctx.policy, ctx.now, ctx.state, NO_JITTER);
      policy.nextDelayMs(ctx.policy, ctx.now, ctx.state, NO_JITTER);
      policy.shouldApply(ctx.policy, { klass: 'hot', dirty: ctx.dirty });
      policy.startupMode(ctx.policy);
      policy.backoffMs(ctx.policy, ctx.state.failures || 0);
      return null;
    } catch (e) {
      return '抛异常: ' + e.message;
    }
  }],
];

function CONSTRINTS_SKIP_DIRTY(p) {
  const c = (p && p.constraints) || {};
  return c.skipWhenDirty !== false;
}

// ---------- 额外：边界/退化配置的专项组合（不进主笛卡尔积） ----------
function edgeCases() {
  const noon = new Date('2026-09-30T12:00:00').getTime();
  const base = {
    enabled: true, onStartup: 'checkAndApply',
    schedule: { mode: 'interval', intervalMinutes: 60, dailyAt: '09:00', jitterMinutes: 5 },
    quietHours: { from: '23:00', to: '07:00' },
    apply: 'auto', constraints: { ...CONSTRAINTS },
  };
  const out = [];
  const mk = (name, mut, extra) => {
    const p = JSON.parse(JSON.stringify(base));
    mut(p);
    out.push({ name, p, ...(extra || {}) });
  };
  mk('intervalMinutes=0（非法 → 回落默认 60 分钟）', (p) => { p.schedule.intervalMinutes = 0; });
  mk('intervalMinutes=1（合法但过小 → 抬到 5 分钟下限）', (p) => { p.schedule.intervalMinutes = 1; });
  mk('intervalMinutes=-10（负数 → 时刻落在过去）', (p) => { p.schedule.intervalMinutes = -10; });
  mk('intervalMinutes=NaN', (p) => { p.schedule.intervalMinutes = NaN; });
  mk('dailyAt 非法 25:00', (p) => { p.schedule.mode = 'dailyAt'; p.schedule.dailyAt = '25:00'; });
  mk('dailyAt 空串', (p) => { p.schedule.mode = 'dailyAt'; p.schedule.dailyAt = ''; });
  mk('maxRetries=0（语义：失败一次即放弃）', (p) => { p.constraints.maxRetries = 0; });
  mk('maxRetries=0 且尚未失败 → 必须仍安排（修复前 0≥0 会误判放弃）', (p) => { p.constraints.maxRetries = 0; }, { failures: 0 });
  mk('maxRetries=0 且已失败 1 次 → 应放弃', (p) => { p.constraints.maxRetries = 0; }, { failures: 1 });
  mk('maxRetries 缺失（默认 3）', (p) => { delete p.constraints.maxRetries; });
  mk('backoffMinutes=[] （空数组 → 回落默认）', (p) => { p.constraints.backoffMinutes = []; });
  mk('skipWhenDirty=false（dirty 也照拉）', (p) => { p.constraints.skipWhenDirty = false; });
  mk('quietHours.from===to（退化）', (p) => { p.quietHours = { from: '12:00', to: '12:00' }; });
  mk('quietHours 只给 from', (p) => { p.quietHours = { from: '00:00' }; });
  mk('jitterMinutes=0', (p) => { p.schedule.jitterMinutes = 0; });
  mk('schedule 缺失', (p) => { delete p.schedule; });
  mk('policy 为空对象', (p) => { Object.keys(p).forEach((k) => delete p[k]); });
  return out.map(({ name, p, failures }) => ({ name, p, failures, now: noon }));
}

// ---------- 主流程 ----------
function buildCtx(enabled, onStartup, mode, intervalMinutes, dailyAt, apply, quietHours,
  now, lastCheckOffset, failures, dirty) {
  const policyObj = {
    enabled,
    onStartup,
    schedule: { mode, intervalMinutes, dailyAt, jitterMinutes: 5 },
    quietHours: quietHours || undefined,
    apply,
    constraints: { ...CONSTRAINTS },
  };
  const state = {
    lastCheckAt: lastCheckOffset === null ? undefined : now + lastCheckOffset,
    failures,
  };
  return { policy: policyObj, now, state, dirty };
}

// ---------- 界面决策组合矩阵（置灰级联 + 更新按钮） ----------
const ui = require('../application/renderer/ui-state');

function uiMatrix() {
  const dims = {
    enabled: [true, false],
    skipUpdate: [true, false],
    onStartup: ui.STARTUP_VALUES, // 三态进矩阵：下拉值必须与契约值一一对应
    scheduleMode: ['off', 'interval'],
    apply: ['auto', 'notify'],
    behind: [true, false],
    dirty: [true, false],
  };
  const keys = Object.keys(dims);
  const bad = [];
  let total = 0;

  const walk = (i, acc) => {
    if (i === keys.length) {
      total++;
      const snap = { ...acc };
      const ctl = ui.policyControls({
        enabled: acc.enabled, skipUpdate: acc.skipUpdate,
        scheduleMode: acc.scheduleMode, onStartup: acc.onStartup,
      });
      const btn = ui.updateButtonVisible({
        apply: acc.apply, behind: acc.behind, dirty: acc.dirty,
      });
      const v = (msg) => bad.push({ msg, combo: snap });

      if (ctl.masterDisabled) v('总开关被置灰：关掉后就再也打不开了');
      if (ctl.detailsDisabled !== !acc.enabled) {
        v(`细项置灰应由 enabled 单独决定（enabled=${acc.enabled} → 期望 ${!acc.enabled}，实际 ${ctl.detailsDisabled}）`);
      }
      if (acc.skipUpdate && ctl.detailsDisabled && acc.enabled) {
        v('验收档把细项也置灰了：改动写本机 config.json 是有效的，不该禁用');
      }
      if (ctl.noteVisible !== !!(ctl.note)) v('noteVisible 与 note 内容不一致');
      // 文案优先级：验收档 > 已关闭（两者同时成立时只说验收档，否则两句互相打架）
      if (!acc.enabled && !acc.skipUpdate && !ctl.note.includes('自动更新已关闭')) v('关闭时应给出说明文案');
      // 启用但三个时机全关（开机 off + 定时 off）→ 必须提示「只剩手动」；否则不应有提示条
      const noTiming = acc.scheduleMode === 'off' && acc.onStartup === 'off';
      if (acc.enabled && !acc.skipUpdate) {
        if (noTiming && !ctl.note.includes('时机全部关闭')) v('时机全关时应提示只剩手动检查');
        if (!noTiming && ctl.noteVisible) v('启用且非验收档/非全关时不应有提示条');
      }
      if (acc.skipUpdate && !ctl.note.includes('验收档')) v('验收档应给出说明文案');

      // 开机三态：下拉值必须与契约值一致（曾经二值复选框表达不出 off）
      const stc = ui.startupControl(acc.onStartup);
      if (stc.value !== acc.onStartup || stc.invalid) {
        v(`onStartup=${acc.onStartup} 映射异常：value=${stc.value} invalid=${stc.invalid}`);
      }

      // 单一真相源：apply=notify 才给手动入口（autoPull 已废弃，不再参与）
      const expectBtn = acc.apply === 'notify' && acc.behind && !acc.dirty;
      if (btn !== expectBtn) v(`更新按钮：期望 ${expectBtn}，实际 ${btn}`);
      if (acc.dirty && btn) v('dirty 时不应给「更新」按钮（拉了会抹掉用户改动）');
      if (acc.behind === false && btn) v('没有可用更新时不应显示「更新」按钮');
      return;
    }
    const k = keys[i];
    for (const val of dims[k]) { acc[k] = val; walk(i + 1, acc); }
    delete acc[k];
  };
  walk(0, {});

  console.log('\n== 界面决策组合矩阵 ==');
  console.log(`维度：${keys.join(' × ')}`);
  console.log(`组合总数：${total}`);
  if (!bad.length) {
    console.log('✓ 全部界面组合通过');
  } else {
    console.log(`✗ ${bad.length} / ${total} 个界面组合违反`);
    bad.slice(0, 6).forEach((b) => console.log(`      · ${b.msg}\n        ${describeCombo(b.combo)}`));
  }
  return { total, bad: bad.length };
}

function describeCombo(acc) {
  return Object.keys(acc).map((k) => `${k}=${JSON.stringify(acc[k])}`).join(' ');
}

function main() {
  const violations = new Map(); // invariant name -> {count, samples[]}
  const record = (name, combo, msg) => {
    if (!violations.has(name)) violations.set(name, { count: 0, samples: [] });
    const v = violations.get(name);
    v.count++;
    // 必须存快照：acc 是同一个对象，循环结束会被 delete 清空
    if (v.samples.length < 3) v.samples.push({ combo: { ...acc }, msg });
  };

  let total = 0;
  const keys = Object.keys(DIMS);
  const walk = (i, acc) => {
    if (i === keys.length) {
      total++;
      const ctx = buildCtx(
        acc.enabled, acc.onStartup, acc.mode, acc.intervalMinutes, acc.dailyAt, acc.apply,
        acc.quietHours, acc.now, acc.lastCheckAt, acc.failures, acc.dirty);
      let checkRes;
      try {
        checkRes = policy.shouldCheck(ctx.policy, ctx.now, ctx.state, NO_JITTER);
      } catch (e) {
        record('I10 任意组合都不得抛异常（含非法/退化输入）', acc, 'shouldCheck 抛异常: ' + e.message);
        return;
      }
      ctx.checkRes = checkRes;
      for (const [name, fn] of INVARIANTS) {
        let r = null;
        try { r = fn(ctx); } catch (e) { r = '不变量自身抛异常: ' + e.message; }
        if (r) record(name, acc, r);
      }
      return;
    }
    const k = keys[i];
    for (const v of DIMS[k]) { acc[k] = v; walk(i + 1, acc); }
    delete acc[k];
  };
  walk(0, {});

  const describe = (acc) => keys.map((k) => `${k}=${JSON.stringify(acc[k])}`).join(' ');

  console.log('== updatePolicy 组合矩阵 ==');
  console.log(`维度：${keys.join(' × ')}`);
  console.log(`组合总数：${total}`);
  console.log(`不变量：${INVARIANTS.length} 条\n`);

  if (violations.size === 0) {
    console.log('✓ 全部组合通过所有不变量');
  } else {
    for (const [name, v] of violations) {
      console.log(`✗ ${name} — 违反 ${v.count} / ${total} 个组合`);
      v.samples.forEach((s) => console.log(`      · ${s.msg}\n        ${describe(s.combo)}`));
    }
  }

  console.log('\n== 边界/退化配置专项 ==');
  let edgeBad = 0;
  for (const c of edgeCases()) {
    const { name, p, now } = c;
    // 用「刚检测完」的状态：逾期立即检测本就正确，看不出间隔是否被写坏
    const state = { lastCheckAt: now, failures: 0 };
    if (c.failures) state.failures = c.failures;
    const tag = c.failures ? `（failures=${c.failures}）` : '';
    let line;
    try {
      const sc = policy.shouldCheck(p, now, state, NO_JITTER);
      const nd = policy.nextDelayMs(p, now, state, NO_JITTER);
      const sa = policy.shouldApply(p, { klass: 'hot', dirty: true });
      line = `check=${sc.check} nextDelayMs=${nd === null ? 'null' : (nd / MINUTE).toFixed(1) + 'min'}` +
        ` applyOnDirty=${sa} reason="${sc.reason}"`;
    } catch (e) {
      line = '✗ 抛异常: ' + e.message;
      edgeBad++;
    }
    console.log(`  · ${name}${tag}\n      ${line}`);
  }

  const uiRes = uiMatrix();

  const totalViolations = [...violations.values()].reduce((a, b) => a + b.count, 0);
  console.log(`\n结果：策略 ${total} 组合 / ${totalViolations} 处违反 · ` +
    `界面 ${uiRes.total} 组合 / ${uiRes.bad} 处违反 · 边界异常 ${edgeBad}`);
  process.exit(totalViolations || uiRes.bad || edgeBad ? 1 : 0);
}

main();
