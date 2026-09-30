// ui-state.js — 界面决策的纯函数（renderer 专用）
//
// 为什么单独一个文件：置灰级联和「更新」按钮该不该出现，本质是策略判定的延伸，
// 但写在 renderer.js 里就没法测（renderer.js 顶层要用 window.api，node 一 require 就炸）。
// 抽成无 window 依赖的纯函数后，policy-matrix 能把界面组合也穷举一遍。
//
// 浏览器里挂到 window.uiState；node 里走 module.exports。
'use strict';

/**
 * 自动更新设置区的置灰决策。
 * 规则（2026-09-30 改）：
 *   - 总开关永远可点 —— 否则关掉之后就再也打不开了；
 *   - 细项只在总开关关闭时置灰（关了改细项没意义）；
 *   - skipUpdate（验收档）不置灰任何东西，只用提示条说明「当前档不生效」，
 *     因为改动会写进本机 config.json，换到正式档后是有效的。
 */
function policyControls(input) {
  const enabled = !!(input && input.enabled);
  const skipUpdate = !!(input && input.skipUpdate);
  const schedMode = (input && input.scheduleMode) || 'off';
  const startup = (input && input.onStartup) || 'off';
  // 三个时机（开机 / 定时）全关时，总开关开着也不会有任何自动行为 —— 必须直说，别让用户以为在自动更新
  const noTiming = schedMode === 'off' && startup === 'off';
  let note = '';
  if (skipUpdate) {
    note = '当前是验收档（skipUpdate=开）：不访问远程，自动更新暂不生效；改动会保存到本机 config.json，换到正式档后生效。';
  } else if (!enabled) {
    note = '自动更新已关闭：只会手动检查，不会定时/开机检测。';
  } else if (noTiming) {
    note = '自动更新的时机全部关闭（开机不检查、无定时检测），只有手动点「检查更新」会联网。';
  }
  return {
    masterDisabled: false,      // 总开关永不置灰
    detailsDisabled: !enabled,  // 细项只在总开关关闭时置灰
    note,
    noteVisible: !!note,
  };
}

/**
 * 「更新」按钮是否显示。
 * 只在 apply=notify（只提示、把打断权交还用户）时给手动入口：
 *   - apply=auto 意味着用户已授权自动生效，再给按钮是多余的一步；
 *   - dirty 时不给 —— 拉了会抹掉用户改动，点了也没用。
 * 旧的 autoPull 开关已废弃（2026-09-30）：它只影响显示、不影响行为，
 * 导致「抬头写仅提示、实际自动拉取」，语义统一到 apply 后不再参与判定。
 */
function updateButtonVisible(input) {
  const i = input || {};
  return i.apply === 'notify' && !!i.behind && !i.dirty;
}

/**
 * 开机行为的下拉框决策。
 * onStartup 是三值（off / check / checkAndApply），曾用二值复选框表达：
 * 不勾写回的是 check —— 界面读作「开机不检查」，实际每次启动都联网比对一次，语义错位。
 * 改成三选下拉后，值与契约一一对应；非法值回落 off 并标记 invalid（契约校验本来也会报）。
 */
const STARTUP_VALUES = ['off', 'check', 'checkAndApply'];

function startupControl(onStartup) {
  const valid = STARTUP_VALUES.includes(onStartup);
  return {
    value: valid ? onStartup : 'off',
    invalid: !valid,
  };
}

const api = { policyControls, updateButtonVisible, startupControl, STARTUP_VALUES };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  window.uiState = api;
}
