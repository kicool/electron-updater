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
[本机 clone]  local/app-checkout            （release 工作树，应用 loadFile 加载它）
             local/dev-master  （可选，开发者用 git worktree 拉出的 master 工作树，与运行态隔离）
```

为什么需要两个分支（KISS / 奥卡姆）：
- 一个 git 工作树同一时刻只能有一个分支的实时文件；应用要加载 `release` 且被 `reset --hard` 热更，
  开发者又要在 `master` 改代码——两者物理隔离是硬约束。
- `git worktree` 用 git 原生能力开出第二个目录（`dev-master`），**不引入任何自研同步/锁机制**，
  实体最少、用现成原语，符合 KISS。
- 纯用户机其实只要 `release` 单分支（`setup.sh` 默认 `--single-branch`），`master`/`dev-master` 是「开发态」的可选扩展，
  完全在 `updater.js` 视野之外。

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
  └─ lastStatus = checkUpdate(CONFIG.autoPull)   // 启动即按 autoPull 决定是否拉取
  └─ createWindow()
        └─ loadFile(appRoot + CONFIG.appEntry)    // src/application/renderer/index.html
        └─ did-finish-load → 推 'update:status' 与 'update:config' 给渲染层
```

### 检查更新（main.js IPC）
```js
// autoPull=true：落后则直接拉取，仅渲染层改动时自动 reload（无重启）
ipcMain.handle('check-update', async () => {
  const s = await checkUpdate(CONFIG.autoPull);
  lastStatus = s;
  if (CONFIG.autoPull && s.ok && s.updated && s.onlyRenderer && win) win.webContents.reload();
  return s;
});
// 手动触发实际拉取（notify-only 模式「更新」按钮调用）
ipcMain.handle('apply-update', async () => {
  const s = await checkUpdate(true);
  lastStatus = s;
  if (s.ok && s.updated && s.onlyRenderer && win) win.webContents.reload();
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

## 四、自动拉取 vs 仅提示（`autoPull`）

写在 `src/application/config.json`（由 `setup.sh` 生成，已被 .gitignore）：

- `autoPull: true`（默认）：点「检查更新」落后于远程则**自动 pull**，渲染层改动即时刷新。
- `autoPull: false`（仅提示）：检查只 `fetch` 比对、不拉取；渲染层收到 `behind` 状态时显示「更新」按钮，
  用户点按才调用 `apply-update` 真正 pull。启动时也按此开关决定是否自更新。

---

## 五、git 落点表（本机侧）

| 路径 | 角色 | 怎么来 |
|---|---|---|
| `local/app-checkout` | **用户机 clone 的 release 工作树** | `setup.sh` 跑 `git clone -b release --single-branch` 到这里；应用只加载它 |
| `local/dev-master` | **开发者 master 工作树（可选）** | 开发者 `git worktree add ../dev-master master`；`updater.js` 完全不知道它 |
| `kicool/electron-updater` 远程 | **唯一源 / 发布目标** | `publish.sh` 或开发者手动 `merge master→release && push` |
| `src/application/renderer/` | **应用源文件模板（热更目标）** | 仓库自带，用户 clone 后由 `local/app-checkout` 持有运行副本 |

> 早期版本用「主仓库 master + worktree 出 release」双目录；本版按奥卡姆精简为「默认只 clone release 单分支」，
> 开发态（master worktree）与本升级方案**解耦**，开发者按需自行开 worktree。

---

## 六、与 04-gitee-launcher 的区别

| 项 | 04-gitee-launcher | 本仓库 |
|---|---|---|
| 远端 | 本地 bare 仓库模拟 Gitee | **真实 GitHub 仓库** |
| 用户 clone 策略 | — | **只 clone `release` 单分支**，直接加载 |
| 开发态 | — | **解耦**：开发者 `git worktree` 拉 master，updater 不感知 |
| 脚本 | setup / seed / publish / selftest | setup / publish / selftest（**无 seed**：仓库已是完整应用，无需引导播种） |
| 拉取策略 | 固定自动 | `autoPull` 可切换「自动 / 仅提示」 |
| 目录 | 扁平（main.js/app/...） | 规范分层：`docs/` + `src/application/` + `tools/` |

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
- **热更判定前缀写死 `'app/'`** → 改为由 `path.dirname(CONFIG.appEntry)` 推导，渲染层目录改名后判定仍正确。
