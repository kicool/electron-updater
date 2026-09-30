// renderer.js — 这是「会被热更新的应用本体」
// FEATURE_VERSION 是演示标记：A 角色在 GitHub 发布新版本时改它，
// 本地 pull 后渲染层 reload 即生效（无重启）。把它当成你的「易变业务逻辑」。
window.FEATURE_VERSION = "V2";

// 注意：不要写 `const api = window.api`！contextBridge 暴露的 window.api 是
// 不可配置(configurable:false)的全局属性，按 JS 规范同名 const 词法声明会直接
// 抛 SyntaxError（整个脚本不执行）。换个名字接收即可。
const bridge = window.api;
const $ = (id) => document.getElementById(id);

// autoPull=false（仅提示模式）时，落后才显示「更新」按钮让用户手动拉取
let autoPull = true;
let env = null; // 加载环境：哪棵树 / 根路径 / 相对根入口 —— 验收时第一眼看这个
if (bridge && bridge.onConfig) bridge.onConfig((c) => {
  autoPull = !!(c && c.autoPull);
  if (c && c.env) { env = c.env; renderEnv(); }
});

// 注意：loadFile 加载的页面没有 Node，但通过 preload 的 contextBridge 拿到 api。
function statusText(s) {
  if (!s) return '初始化…';
  if (s.offline) return '⚠️ 离线/无法连接远程，使用本地当前版本';
  if (s.skipped) return '本地验收模式（skipUpdate 开：不访问远程，只看本地代码）';
  if (s.updated) return s.needsRestart ? '✅ 已拉取更新，需重启应用生效' : '✅ 已拉取更新（渲染层，无需重启）';
  if (s.behind) return '🔔 有可用更新，点击「更新」拉取';
  return '✓ 已是最新（' + ((env && env.branch) || 'release') + '）';
}

// 渲染「加载环境」抬头：验收时先确认这里显示的树和路径，再看功能效果
function renderEnv() {
  if (!env) return;
  $('env-tree').textContent = env.tree;
  $('env-root').textContent = env.root;
  $('env-entry').textContent = env.entry;
  $('env-preload').textContent = env.preload;
  $('env-ref').textContent = env.branch + ' @ ' + env.head + (env.ref === env.branch ? '' : '（' + env.ref + '）');
  $('env-autopull').textContent = autoPull ? '开（自动拉取）' : '关（仅提示）';
}

function render(s) {
  if (!s) return;
  if (s.version) $('version').textContent = s.version;
  $('status').textContent = statusText(s);
  $('feature').textContent = window.FEATURE_VERSION; // 关键：反映所载入代码里的标记
  // 仅提示模式且落后时，展示「更新」按钮；其余情况隐藏
  $('apply').style.display = (!autoPull && s && s.behind) ? 'inline-block' : 'none';
  if (!autoPull && s && s.behind) $('status').textContent = '🔔 有可用更新，点「更新」手动拉取';
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
