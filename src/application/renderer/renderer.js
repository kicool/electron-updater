// renderer.js — 这是「会被热更新的应用本体」
// FEATURE_VERSION 是演示标记：A 角色在 GitHub 发布新版本时改它，
// 本地 pull 后渲染层 reload 即生效（无重启）。把它当成你的「易变业务逻辑」。
window.FEATURE_VERSION = "V2";

// 注意：不要写 `const api = window.api`！contextBridge 暴露的 window.api 是
// 不可配置(configurable:false)的全局属性，按 JS 规范同名 const 词法声明会直接
// 抛 SyntaxError（整个脚本不执行）。换个名字接收即可。
const bridge = window.api;
const $ = (id) => document.getElementById(id);

// 旧字段 autoPull 已废弃：语义并入 updatePolicy.apply（auto=自动生效 / notify=只提示）。
// 它当时只影响显示、不影响行为，是「抬头写仅提示、实际自动拉取」的来源。
let env = null;    // 加载环境：哪棵树 / 根路径 / 相对根入口 —— 验收时第一眼看这个
let policy = null; // 时机策略（注册表默认值 + 本机 config.json 覆盖后的生效值）
let schedule = null;
let units = null;  // 更新单元白名单（团队契约，只读展示）
let skipUpdate = false;
if (bridge && bridge.onConfig) bridge.onConfig((c) => {
  skipUpdate = !!(c && c.skipUpdate);
  if (c && c.env) { env = c.env; renderEnv(); }
  if (c && c.policy) { policy = c.policy; schedule = c.schedule || null; renderPolicy(); }
  if (c && c.units) { units = c.units; renderUnits(); }
});

const KLASS_TEXT = {
  none: 'none · 与运行态无关（无需重启）',
  hot: 'hot · 渲染层热更（无需重启）',
  restart: 'restart · 需重启应用',
  reinstall: 'reinstall · git 拉不到，需重装',
};

// 注意：loadFile 加载的页面没有 Node，但通过 preload 的 contextBridge 拿到 api。
function statusText(s) {
  if (!s) return '初始化…';
  if (s.offline) return '⚠️ 离线/无法连接远程，使用本地当前版本';
  if (s.skipped) return '本地验收模式（skipUpdate 开：不访问远程，只看本地代码）' +
    (s.reason ? ' — ' + s.reason : '');
  if (s.updated) {
    const k = s.klass || (s.needsRestart ? 'restart' : 'hot');
    if (k === 'none') return '✅ 已拉取更新（无运行态影响，不打扰）';
    if (k === 'hot') return '✅ 已拉取更新（渲染层，无需重启）';
    if (k === 'reinstall') return '⚠️ 已拉取更新，但含 git 无法更新的部分，需重新安装';
    return '✅ 已拉取更新，需重启应用生效';
  }
  if (s.dirty) return '⛔ 本地有 ' + s.dirtyCount + ' 个未提交改动，已跳过自动更新（reset --hard 会抹掉它们）';
  if (s.behind) return '🔔 有可用更新，点击「更新」拉取';
  return '✓ 已是最新（' + ((env && env.branch) || 'release') + '）';
}

function applyText() {
  if (!policy) return '…';
  return policy.apply === 'notify' ? 'notify · 只提示，等我点' : 'auto · 自动拉取并生效';
}

// 渲染「加载环境」抬头：验收时先确认这里显示的树和路径，再看功能效果
function renderEnv() {
  if (!env) return;
  $('env-tree').textContent = env.tree;
  $('env-root').textContent = env.root;
  $('env-entry').textContent = env.entry;
  $('env-preload').textContent = env.preload;
  $('env-ref').textContent = env.branch + ' @ ' + env.head + (env.ref === env.branch ? '' : '（' + env.ref + '）');
  $('env-contract').textContent = env.contractVersion || '—';
  $('env-apply').textContent = applyText();
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderPolicy() {
  if (!policy) return;
  const sch = policy.schedule || {};
  $('pol-enabled').checked = !!policy.enabled;
  const st = (window.uiState || {}).startupControl
    ? window.uiState.startupControl(policy.onStartup)
    : { value: ['off', 'check', 'checkAndApply'].includes(policy.onStartup) ? policy.onStartup : 'off', invalid: false };
  $('pol-startup').value = st.value;
  $('pol-mode').value = sch.mode || 'off';
  $('pol-interval').value = sch.intervalMinutes || 60;
  $('pol-daily').value = sch.dailyAt || '09:00';
  $('pol-apply').value = policy.apply || 'auto';
  $('pol-interval-wrap').style.display = sch.mode === 'interval' ? 'inline' : 'none';
  $('pol-daily-wrap').style.display = sch.mode === 'dailyAt' ? 'inline' : 'none';
  // 置灰/提示的判定移到 ui-state.js（纯函数），这样界面组合也能被 policy-matrix 穷举测试
  const ctl = (window.uiState || {}).policyControls
    ? window.uiState.policyControls({
      enabled: policy.enabled, skipUpdate,
      scheduleMode: (policy.schedule || {}).mode, onStartup: policy.onStartup,
    })
    : { masterDisabled: false, detailsDisabled: !policy.enabled, note: '', noteVisible: false };
  $('pol-enabled').disabled = ctl.masterDisabled;
  ['pol-startup', 'pol-mode', 'pol-interval', 'pol-daily', 'pol-apply']
    .forEach((id) => { $(id).disabled = ctl.detailsDisabled; });
  const note = $('pol-note');
  note.style.display = ctl.noteVisible ? 'block' : 'none';
  if (ctl.note) note.textContent = ctl.note;
  $('pol-last').textContent = fmtTime(schedule && schedule.lastCheckAt);
  $('pol-next').textContent = (schedule && schedule.nextAt) ? fmtTime(schedule.nextAt) : '未安排';
  $('pol-fail').textContent = (schedule && schedule.failures) || 0;
  // 抬头的「更新生效方式」读的是 policy.apply，policy 比 env 晚到一步，这里补刷
  if ($('env-apply')) $('env-apply').textContent = applyText();
}

function renderUnits() {
  if (!units || !units.length) return;
  $('units-body').innerHTML = units.map((u) => {
    const cls = ['hot', 'restart', 'reinstall', 'none'].includes(u.class) ? u.class : 'none';
    return `<tr><td><b>${u.name}</b></td>` +
      `<td><span class="tag ${cls}">${u.class}</span></td>` +
      `<td>${u.action || '—'}${u.fallback ? ' → ' + u.fallback : ''}</td>` +
      `<td class="mono">${(u.paths || []).join('<br>')}</td></tr>`;
  }).join('');
}

async function setPolicy(patch) {
  if (!bridge || !bridge.setUpdatePolicy) {
    $('pol-saved').textContent = '当前 preload 不支持 setUpdatePolicy（旧壳）';
    $('pol-saved').classList.add('show');
    return;
  }
  const r = await bridge.setUpdatePolicy(patch);
  if (r && r.ok) {
    policy = r.policy;
    renderPolicy();
    $('pol-saved').classList.add('show');
    setTimeout(() => $('pol-saved').classList.remove('show'), 2200);
  } else {
    $('pol-saved').textContent = '保存失败: ' + ((r && r.error) || '未知');
    $('pol-saved').classList.add('show');
  }
}

function render(s) {
  if (!s) return;
  if (s.version) $('version').textContent = s.version;
  $('status').textContent = statusText(s);
  $('feature').textContent = window.FEATURE_VERSION; // 关键：反映所载入代码里的标记
  $('klass').textContent = s.klass ? (KLASS_TEXT[s.klass] || s.klass) : '—';
  // 需手动拉取的场合才给「更新」按钮：仅提示模式，或 apply=notify
  // （dirty 时不给按钮：拉了会抹掉用户改动，点了也没用）
  const show = (window.uiState || {}).updateButtonVisible
    ? window.uiState.updateButtonVisible({
      apply: policy && policy.apply, behind: s.behind, dirty: s.dirty,
    })
    : ((policy && policy.apply === 'notify') && s.behind && !s.dirty);
  $('apply').style.display = show ? 'inline-block' : 'none';
  if (show) $('status').textContent = '🔔 有可用更新，点「更新」手动拉取';
  if (s.plan && s.plan.warnings && s.plan.warnings.length) {
    console.warn('[update]', s.plan.warnings.join(' | '));
  }
}

if (bridge && bridge.onStatus) {
  bridge.onStatus(render);
} else if (!bridge) {
  document.getElementById('status').textContent = '⚠️ window.api 不可用（preload 未加载）— 查看启动终端日志';
}

$('check').addEventListener('click', async () => {
  $('status').textContent = '检查中…';
  const s = await bridge.checkUpdate();
  render(s);
  if (s && s.needsRestart) {
    if (confirm('更新涉及主进程/依赖，需重启以生效。现在重启？')) bridge.relaunch();
  }
});

$('apply').addEventListener('click', async () => {
  $('status').textContent = '更新中…';
  const s = await bridge.applyUpdate();
  render(s);
  if (s && s.needsRestart) {
    if (confirm('更新涉及主进程/依赖，需重启以生效。现在重启？')) bridge.relaunch();
  }
});

$('pol-enabled').addEventListener('change', (e) => setPolicy({ enabled: e.target.checked }));
$('pol-startup').addEventListener('change', (e) =>
  setPolicy({ onStartup: e.target.value }));
$('pol-mode').addEventListener('change', (e) => setPolicy({ schedule: { mode: e.target.value } }));
$('pol-apply').addEventListener('change', (e) => setPolicy({ apply: e.target.value }));
$('pol-interval').addEventListener('change', (e) =>
  setPolicy({ schedule: { intervalMinutes: Math.max(5, Number(e.target.value) || 60) } }));
$('pol-daily').addEventListener('change', (e) => setPolicy({ schedule: { dailyAt: e.target.value } }));
