# 实现方案说明（IMPLEMENTATION）

> 一句话：把 **git 当 CDN、`git pull` 当更新协议**，远端是**真实 GitHub 仓库**（`kicool/electron-updater`）。
> 仓库即「方案的源」：**开发者写 `master`、用户跑 `release`**，应用从 `release` 加载代码；
> 检测落后则 pull，**渲染层改动自动 reload（无重启热更）**，主进程 / 依赖改动提示重启。
>
> 使用步骤（SSH、安装、发版、构建）见 `README.md` 与 `docs/build.md`，本文只讲**实现原理**。

---

## 一、单一源 + 双分支模型

```
kicool/electron-updater  （唯一源，GitHub）
├── master    开发者分支：写代码、集成分支
└── release   用户分支：应用运行时加载、自动 pull 的目标
        ▲ 开发者 merge master→release 并 push
        │
   git fetch / reset --hard  （本机 clone 副本去拉）
        │
[本机]  electron-updater/    ← 开发侧：master 主仓，写代码/commit/V1 自验
        electron-updater-release/  ← 开发侧：release 独立 clone，merge + push
        electron-updater-user/     ← 用户侧：release 独立 clone，应用就加载它自己
```

为什么需要两个分支（KISS / 奥卡姆）：
- 一个 git 工作树同一时刻只能有一个分支的实时文件；开发者要在 `master` 改代码、用户要加载
  `release` 并被 `reset --hard` 热更——两者**隔离**是硬约束，但隔离靠**目录/仓库份数**，
  不是靠目录层级。
- **1 份化（当前形态）**：加载树就是仓库自己（`repoPath` 默认 `..`，相对 `shellDir` 解析 = 仓库根），
  不再另开第二份目录。renderer / preload / registry 三者**同源、同一次 pull**，
  直接消灭「pull 后 renderer 是新的、preload 是旧的」这类契约错配的根因。
- 旧形态的 `local/app-checkout` + `local/dev-master` 双目录**已废弃**：那份第二目录本来就是多余的
  （`reset --hard` 只动 tracked 文件，而 `node_modules/`、`config.json` 都在 `.gitignore` 里）。
- 保护机制随形态一起改：1 份化后不再靠物理隔离兜底，靠 **`updater.js` 的 dirty check**
  （pull 前 `git status --porcelain --untracked-files=no` 非空则拒绝拉取并回报）。
- 开发侧长期目录是 **master 主仓 + release 独立 clone** 两份；临时并行任务用 `git worktree`
  （用完即删）。模拟用户必须**独立 clone**（与真实用户同构：自有 `.git`、自有 remote）。

---

## 二、四层代码逻辑（均在 `src/application/`）

| 层 | 文件 | 职责 |
|---|---|---|
| 更新引擎 | `updater.js` | 纯 git 操作（fetch/compare/diff/pull/reset/getVersion），**不依赖 electron**，可单测 |
| 启动器 | `main.js` | 解析 release 树 → 启动即检测/pull → 加载渲染层 → IPC 处理检查/更新 |
| 桥接 | `preload.js` | `contextBridge` 暴露 `window.api`（checkUpdate/applyUpdate/relaunch/onStatus/onConfig） |
| 渲染层 | `renderer/` | **会被热更新的应用本体**；`FEATURE_VERSION` 是演示标记 |

`updater.js` 只认「本地 git 仓库 + `origin/release`」——对远端是本地 bare 还是 GitHub 无感。
换远端只改 `scripts/` 和 `config.json`，不动应用逻辑。

### 启动序列（main.js）
```
app.whenReady()
  └─ appRoot = resolveAppTree(CONFIG)   // useWorktree=false → 直接 path.resolve(repoPath)
  └─ lastStatus = checkUpdate(pull = shouldApply(POLICY))  // 启动行为由 updatePolicy.onStartup + apply 决定
  └─ createWindow()
        └─ loadFile(appRoot + CONFIG.appEntry)    // src/application/renderer/index.html
        └─ did-finish-load → 推 'update:status' 与 'update:config' 给渲染层
```

### 检查更新（main.js IPC）
```js
// apply=auto：落后则直接拉取，仅渲染层改动时自动 reload（无重启）
ipcMain.handle('check-update', async () => {
  const s = await checkUpdate({ pull: shouldApply(POLICY, {}) });
  lastStatus = s;
  applyIfPossible(s);   // apply=notify 直接返回；hot 才 reload，restart/reinstall 只提示不擅自打断
  return s;
});
// 手动触发实际拉取（notify 模式「更新」按钮调用）
ipcMain.handle('apply-update', async () => {
  const s = await checkUpdate({ pull: true, mode: 'manual' });
  lastStatus = s;
  applyIfPossible(s);   // 同上：hot → reload；restart/reinstall → 提示重启或重装
  return s;
});
```

---

## 三、热更判定（改了什么决定怎么更）

pull 后 `updater.diffFiles` 列出 `local..remote` 变更文件，`onlyRendererChanges` 判定：

```js
// main.js 按 appEntry 计算前缀并传入（不再写死 'app/'）
const rendererPrefix = path.dirname(CONFIG.appEntry) + '/';   // → "src/application/renderer/"
const onlyRenderer = updater.onlyRendererChanges(files, rendererPrefix);
```

| 改动范围 | 结果 | 体验 |
|---|---|---|
| 全部在 `src/application/renderer/` | `onlyRenderer=true` | `reload()` **无重启热更** |
| 触及 `src/application/main.js` / `preload.js` / `package.json` / 依赖 | `onlyRenderer=false` | 返回 `needsRestart`，界面提示**重启**（`app.relaunch()`） |
| 触及 Electron 框架 / 原生模块 | 不可热更 | 只能整体换 Electron 版本 |

---

## 四、自动生效 vs 仅提示（`updatePolicy.apply`）

默认在 `registry.json`（`updatePolicy.apply`），本机差异写在 `src/application/config.json`：

- `apply: auto`（默认）：点「检查更新」落后于远程则**自动 pull**，渲染层改动即时刷新。
- `apply: notify`（仅提示）：检查只 `fetch` 比对、不拉取；渲染层收到 `behind` 状态时显示「更新」按钮，
  用户点按才调用 `apply-update` 真正 pull。启动时也按此开关决定是否自更新。

> 旧字段 `autoPull`（布尔）已于 2026-09-30 废弃：它只影响界面显示、不影响行为，
> 会出现「抬头写仅提示、实际自动拉取」的假象，语义统一到 `apply`。
> 仍写着的旧 `config.json` 会在 `registry.js` 里被迁移：`autoPull:false` 且未显式设 `apply` → 视为 `notify`，
> 以免删字段把用户从「只提示」静默改成「自动生效」。

---

## 五、git 落点表（本机侧）

| 路径 | 角色 | 怎么来 |
|---|---|---|
| 仓库根目录 | **加载树本身（1 份化）** | 用户 `git clone -b release` 后就是它；`setup.sh` 只写 `config.json`（`repoPath`= 本目录） |
| `electron-updater-release/` | **开发侧 release 独立 clone** | `git clone` 全分支 → `checkout -b release origin/release`，在这里 merge + push |
| `electron-updater-user/` | **用户侧独立 clone** | 与真实用户同构（自有 `.git`/remote），应用加载它自己 |
| `kicool/electron-updater` 远程 | **唯一源 / 发布目标** | 开发者在 release clone 里 `merge FETCH_HEAD && push`（https 推不动时用 SSH URL） |
| `src/application/renderer/` | **应用源文件（热更目标）** | 仓库自带，就在加载树里，`reset --hard` 后直接生效（无重启热更） |

> 历史沿革：早期是「主仓库 master + worktree 出 release」双目录 → 再简化为「默认只 clone release 单分支
> 到 `local/app-checkout`」→ **当前是 1 份化**：加载树=仓库自己，不再有任何第二份目录。

---

## 六、与 04-gitee-launcher 的区别

| 项 | 04-gitee-launcher | 本仓库 |
|---|---|---|
| 远端 | 本地 bare 仓库模拟 Gitee | **真实 GitHub 仓库** |
| 用户 clone 策略 | — | **只 clone `release` 单分支**，直接加载 |
| 开发态 | — | **解耦**：开发者 `git worktree` 拉 master，updater 不感知 |
| 脚本 | setup / seed / publish / selftest | setup / publish / selftest（**无 seed**：仓库已是完整应用，无需引导播种） |
| 拉取策略 | 固定自动 | `updatePolicy.apply` 可切换「自动生效 / 仅提示」（旧字段 `autoPull` 已废弃） |
| 目录 | 扁平（main.js/app/...） | 规范分层：`docs/` + `src/application/` + `src/tools/` |

---

## 七、已知限制

- 必须**源码运行**（`electron .`），放弃签名 / asar / 商店分发（见 `docs/build.md` 第 6 节）。
- 主进程 / preload / `node_modules` 改动仍需重启；`package.json` 变时 pull 后应 `npm ci` + 重启（骨架未自动做）。
- Electron 框架 / 原生模块 git 改不了，只能整体换版本。
- 供应链：任何能 push `release` 的人，代码会被用户自动拉取执行——团队内部 / 内网可控。

---

## 附录：本仓库踩过的坑（供复盘）

- **`const api = window.api` 撞名**：`contextBridge.exposeInMainWorld` 暴露的全局属性 `configurable:false`，
  页面同名 `const` 抛 `SyntaxError` 使整段脚本不执行 → 接收端改名 `bridge`。
- **缺 `package.json` 的 `main` 字段**：Electron 默认找 `index.js`，入口是 `main.js` 会报 `Cannot find module` → 补 `"main": "src/application/main.js"`。
- **bash 3.2 + 中文 + `set -u` 的 `${VAR?}` 未绑定崩溃** → 改 `set -eo pipefail` + `printf` 传参。
- **reload 后「初始化…」空窗**：`did-finish-load` 每次页面加载完再 `fetch` 一次 GitHub 造成冗余空窗 → 加 `lastStatus` 缓存 + `update:config` 复用，不再二次 fetch。
- **热更判定前缀写死 `'app/'`** → 改为由 `path.dirname(CONFIG.appEntry)` 推导，渲染层目录改名后判定仍正确；
  再进一步收敛到 `registry.json` 的 `rendererDir`，由 `registry.js` 推导 `rendererPrefix`。
- **契约散落在源码各处（路径 / 名单在多处重复）** → 引入 `src/application/registry.json` 作为唯一事实源，
  `registry.js` 合并「静态默认值 + `config.json` 本机覆盖」。三道机器校验：`appEntry⊂rendererDir`、
  启动时路径存在性、`bridgeApi` 名单与 `preload.js` 实现双向一致。
