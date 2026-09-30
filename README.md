# electron-git-pull-updater — 基于 GitHub 的 Electron 应用 git-pull 更新方案

一个**完整的 Electron 应用**，其更新机制用「git 当 CDN、git pull 当更新协议」：
应用从 GitHub 仓库的 `release` 分支加载代码，检测到新版本就 `fetch` + `reset --hard` 拉取，
渲染层改动**无重启热更**，主进程 / 依赖改动提示重启。

> **单一源原则**：开发者和用户拉取的是**同一个 GitHub 仓库**，只是分支不同——
> 用户拉 `release`（只读运行），开发者拉 `master`（开发），开发完合并回 `release` 再 push。
> 仓库即「方案的源」，任何人按文档都能构建出这个 Electron 应用。

## 核心思想：一个仓库，两个分支

```
            kicool/electron-updater  （唯一源，GitHub）
            ├── master    开发者分支（写代码、发版前的集成分支）
            └── release   用户分支（应用运行时实际加载、自动 pull 的目标）
                     ▲
                     │ 开发者 merge master→release 并 push
                     │
            ┌────────┴────────┐
      开发者机器             用户机器
    clone master + worktree   clone release（单分支，只读运行）
    （用 git worktree 让两      → local/app-checkout
     分支同时落在不同目录）        → 应用 loadFile 加载它
```

- **用户**：只拿 `release` 单分支，应用启动即检测并自动（或手动）pull `release`。
- **开发者**：在 `master` 上改代码，验证后合并到 `release` 并 push；用户侧下次 pull 即拿到。
- 两分支在同一台机器上靠 **`git worktree`** 隔离到不同目录，互不踩（见「开发者流程」）。

## 更新机制

- `updater.js` 只认「本地 git 仓库 + `origin/release`」，对远端是 GitHub 无感。
- 启动 / 点「检查更新」→ `fetch` 比 HEAD → 落后则 `pull`（`fetch` + `reset --hard`），
  再按 `git diff --name-only` 判定：
  - **改动全在 `src/application/renderer/`** → 仅渲染层 → `reload()` **无重启热更**；
  - **改动触及 `src/application/` 的壳或 `package.json`** → 提示**重启**生效。
- 两种拉取策略由 `autoPull`（写在 `src/application/config.json`）控制：
  - `autoPull: true`（默认）：检查到新版本**自动 pull**；
  - `autoPull: false`（仅提示）：检查只比对、不拉取，界面出现「更新」按钮，**手动点按才 pull**。

## 目录结构

```
electron-git-pull-updater/                  ← 整个仓库就是「方案的源」= 完整 Electron 应用
├── README.md                               （本文件：概览 + 工作流）
├── .gitignore
├── package.json                            # main: src/application/main.js；scripts: start/setup/publish/selftest
├── docs/
│   ├── IMPLEMENTATION.md                   # 设计与实现原理（四层逻辑、git 落点、热更判定）
│   ├── contract-and-release-flow.md        # ★ 文件契约 + 分支工作流（含测试矩阵、环境坑）
│   └── build.md                            # 如何构建 / 运行这个 Electron 应用
├── src/
│   ├── application/                        # Electron 壳（应用逻辑）
│   │   ├── registry.js                     # 契约注册表解析器：合并静态默认值 + 本机覆盖
│   │   ├── registry.json                   # ★ 契约唯一事实源（路径 / bridge API 名单，进 git）
│   │   ├── main.js                         # 启动器（主进程）：校验契约 → 检测/pull → 加载渲染层
│   │   ├── updater.js                      # git 驱动的更新引擎（不依赖 electron，可单测）
│   │   ├── preload.js                      # contextBridge 桥接层（按注册表生成 window.api）
│   │   ├── renderer/                       # 渲染层 = 热更目标（改这里 → 无重启）
│   │   │   ├── index.html
│   │   │   └── renderer.js
│   │   └── config.json                     # 本机差异（repoPath 等绝对路径），已被 .gitignore
│   └── tools/
│       └── real-remote-check.js            # 验证「真实远程读取路径」(clone 公开仓库做 fetch/compare/diff)
├── scripts/
│   ├── setup.sh                            # 用户首次安装：只 clone release 单分支 + 写 config
│   ├── publish.sh                          # 开发者发版：真实 push 到 GitHub release 分支（演示脚本，非真实发版通道）
│   └── verify.sh                           # ★ 验收切换器：一键切到 dev / merge / user 三档加载树并启动
```

## 使用者流程（只想跑这个应用）

### 0. 前置：GitHub 认证（SSH，推荐）
> GitHub 自 2021 年起**不支持账号密码做 git 操作**，必须用 **SSH key** 或 **PAT**。默认走 SSH。

```bash
ls -la ~/.ssh/id_*.pub            # 有 id_*.pub 就跳过下一步
ssh-keygen -t ed25519 -C "you@example.com"   # 没有就生成一个
cat ~/.ssh/id_ed25519.pub         # 复制整段公钥
```
粘到 GitHub：**Settings → SSH and GPG keys → New SSH key**（Title 随意，Key type 选 Authentication Key）。
```bash
ssh -T git@github.com             # 看到 "Hi <you>! You've successfully authenticated" 即成功
```

### 1. 安装并运行
> **前提**：Node **≥ 22.12.0**（electron@44 硬性要求），仓库带 `.nvmrc`，`nvm use` 即可切换。

```bash
bash scripts/setup.sh             # 只 clone release 单分支到 local/app-checkout，并写 config
npm install && npm start          # 装 electron 并启动
```
窗口显示：版本号 / 功能标记 `V1` / 「✓ 已是最新（release）」。
`docs/build.md` 有完整的构建 / 运行说明（含 electron 二进制下载、源码运行等）。

### 2. 接收更新（热更）
开发者发版后，应用下次启动会自动 pull `release`；或在窗口点「检查更新」：
- `autoPull: true` → 自动拉取，仅渲染层改动则**界面无重启刷新**；
- `autoPull: false` → 仅提示「有可用更新」，点「更新」按钮手动拉取。
主进程 / 依赖改动会提示重启，点确认即 `app.relaunch()`。

## 开发者流程（要发新版本）

默认安装只拿 `release` 单分支、**不拉 master、不建 worktree**——绝大多数用户只跑不开发。
开发者需要往 `release` 发版时，用 **`git worktree`** 在同一台机器上同时持有两分支，且与应用运行时**物理隔离**：

```bash
cd electron-git-pull-updater/local/app-checkout
# 单分支 clone 默认不含 master，先取回引用（不动运行中的 release 文件）
git fetch origin master:master
# 用 worktree 拉出开发用的 master 工作树（独立目录，不与应用运行时互相踩）
git worktree add ../dev-master master
```

```
local/
├── app-checkout/     ← release 工作树，应用运行时只加载这里（updater.js 唯一可见）
└── dev-master/       ← master 工作树，你的开发沙箱（updater.js 完全不知道它存在）
```

```bash
cd ../dev-master
# 在这里改代码（比如改 src/application/renderer/renderer.js 的业务逻辑）
git add -A && git commit -m "feat: ..."
# 开发完：把改动合并到 release 并 push（merge 或 cherry-pick 都行）
git checkout -B release origin/release
git merge master            # 或 git cherry-pick <commit>
git push origin release --tags
```

要点：
- `updater.js` 永远只认 `local/app-checkout`（`release` 工作树），对 `dev-master` 一无所知、互不干扰。
- `dev-master` 是你自己的开发沙箱，不是方案的一部分；换机器 / 重装时随时可丢弃重建。
- 想彻底不要开发能力，就只用 `setup.sh` + `publish.sh`，永远不碰 `git worktree`——这正是默认形态。

> 嫌手工 merge 麻烦？`scripts/publish.sh` 可一键模拟 A 角色发版（独立 clone → 改 `FEATURE_VERSION` → 打 tag → push `release`）。
> 注意它是**演示脚本**，不会把 master 的成果 merge 过去，真实发版走上面的手动 merge 流程。

## 验收：界面抬头先自证「加载的是哪棵树」

代码同时存在于 master 工作树、release 工作树、用户检出三处，最容易犯的错是**验的不是你想验的那棵树**——
效果看着对了，其实验的是另一份代码。窗口顶部的「加载环境」抬头就是为此存在：

| 抬头字段 | 含义 |
|---|---|
| 树 | 加载树身份（`treeLabel`，来自 `config.json`；未设则退化为目录名） |
| 根目录（绝对） | 加载树根的实际绝对路径 |
| 入口（相对根） | 渲染层入口相对该根的路径 |
| preload（相对根） | preload 相对该根的路径；出现 `../` 说明它来自运行中的壳，**改动需重启生效** |
| 比对分支 / HEAD | 跟哪个分支比对、本地 HEAD；`detached` 表示分离头 |
| autoPull | 开（自动拉取）/ 关（仅提示） |

三档验收用 `scripts/verify.sh` 一键切换（它负责建树并写好 `config.json` 的 `treeLabel` / `repoPath`）：

```bash
npm run verify dev      # V1 开发自验：dev-master（分离头 master，不拉取）
npm run verify merge    # V2 合并验：dev-release（release + merge master），判据 git diff master 为空
npm run verify user     # V3 用户态：app-checkout（与用户同构），加 --at <旧sha> 可验更新过程
```

V1 刻意用**分离头**：即使误开 autoPull，`reset --hard` 也只移动 HEAD，不会动 master 分支指针、不污染主工作树。

## 换成其他仓库

当前默认绑定 `kicool/electron-updater`（SSH）。要指向别的仓库，给脚本传 URL 覆盖：
```bash
bash scripts/setup.sh   git@github.com:<你>/<repo>.git
bash scripts/publish.sh git@github.com:<你>/<repo>.git
```
`config.json` 由 `setup.sh` 自动写好指向本地 clone，其余代码无需改动。

## 文件契约（改动前必读）

> 完整方案（含 dev/正式一致性分析、工作流命令序列、测试矩阵、环境坑）见 **`docs/contract-and-release-flow.md`**。

本方案没有编译期、没有打包器——**路径和 API 名就是全部契约，且只在运行时兑现**。
所有契约集中在 `src/application/registry.json`（唯一事实源，进 git），由 `registry.js` 解析后供各处取用：

| 契约 | 存放位置 | 谁依赖 |
|---|---|---|
| `appEntry` / `rendererDir` / `rendererEntry` | registry.json | main.js、publish.sh |
| `preload` | registry.json | main.js 的 BrowserWindow |
| `rendererPrefix`（热更判定前缀） | 由 rendererDir 推导 | main.js |
| `window.api` 成员名单 | registry.json 的 `bridgeApi` | preload.js + renderer.js |
| `remote` / `branch` / `autoPull` 默认值 | registry.json | main.js |
| `repoPath`（本机绝对路径） | config.json（gitignore） | main.js |

**注意两个不同的根**：`preload` 相对壳目录（`src/application/`）解析；`appEntry`/`rendererDir` 相对代码树根（appRoot）解析。布局一致但语义不同。

已经是机器校验的三条闸门，写错了会**在窗口打开前报错**，而不是白屏：

1. `registry.js`：`appEntry` 必须落在 `rendererDir` 内，否则「免重启热更」的前提不成立 → throw。
2. `main.js` 的 `verifyContract()`：appEntry / rendererDir / preload 三个路径必须真实存在 → 弹错误框退出。
3. `preload.js`：注册表的 `bridgeApi` 与自身实现必须完全一致（少了没实现、多了没登记都 throw）——
   这条最重要：**pull 后渲染层是新的、preload 仍是旧的**，新 renderer 一旦调用旧的 `window.api` 没有的方法就是 `undefined is not a function`。

搬不动的两处：Electron 的 `package.json → main` 字段（在你任何 JS 执行前就被读取），
以及注册表文件自身的路径。/bootstrap 必须从一个已知位置起步。

## Electron 二进制：130MB 为什么会下第二次

`npm install` 会下载 Electron 运行时（Chromium + Node，zip 约 130MB，解压 307M，落在
`node_modules/electron/dist`）。它**不在 git 里**（`node_modules` 被忽略），是本方案更新不到的那一块。

**下载只该发生一次**，实际有两层保障：

| 层 | 机制 | 证据 |
|---|---|---|
| 1 | `node_modules/electron/dist` 完整且版本匹配时，`install.js` 的 `isInstalled()` 直接 `exit 0`，连缓存都不查 | 实测 `node node_modules/electron/install.js` → 0.185s、无任何输出、exit 0 |
| 2 | dist 不存在时走缓存：`@electron/get` 用 `sha256(下载 URL 去掉文件名)` 作缓存目录名 | `node_modules/@electron/get/dist/Cache.js:16` |

**第 2 层的坑**：key 是 URL 不是版本号。**换镜像 = 换 URL = 缓存 miss = 重新下一次 130MB**，
哪怕文件字节一模一样。本机实测缓存里 `44.4.5` 有两份（各 130,418,529 字节），
反推 hash 后确认一份来自官方 GitHub、一份来自 npmmirror——就是换源造成的。

对策用 `scripts/electron-once.sh`（不联网，只查找/硬链接）：

```bash
npm run electron:cache                                        # 对齐当前配置
npm run electron:cache -- --mirror https://npmmirror.com/mirrors/electron/   # 顺便为镜像源也备好
npm run electron:cache -- --list                              # 看缓存里现在有什么
```

它复刻 `@electron/get` 的算法算出目标缓存目录，缺哪个就把已有的同名 zip **硬链接**过去
（同一 inode，实测占用不变，仍是 592M），所以之后再怎么换源都不会重下。
删 `node_modules` 后重装也只是解压、不下载。

> 缓存目录必定是 `v44.4.5` 这种**带 v 前缀**的形式：`index.js:108` 拼 URL 之前先走
> `normalizeVersion()`（`utils.js:38` 强制补 `v`），除非你显式设了 `ELECTRON_CUSTOM_DIR`。
> **当前环境下真正会用到的 URL 只有两个**：官方 `github.com/…/releases/download/v44.4.5/` 与
> 你配置的镜像 `…/v44.4.5/`。脚本只对齐实际会用到的那个（镜像由 `electron_mirror` 决定）。

要换镜像加速，设一次就别再改：

```bash
npm config set electron_mirror https://npmmirror.com/mirrors/electron/
```

## 已知限制

- 必须**源码运行**（`electron .`），放弃签名 / asar / 商店分发——团队内部、能装 git 的前提。
- 主进程 / preload / `node_modules` 改动仍需重启；`package.json` 变时 pull 后应 `npm ci` + 重启（骨架未自动做）。
- Electron 框架 / 原生模块 git 改不了，只能整体换版本。
- 供应链：任何能 push `release` 的人，代码会被用户自动拉取执行——团队内部 / 内网可控。
- 私有库 token 注入 https URL 会落进 `.git/config`，团队内部分发可接受；更稳妥用 SSH 部署密钥。
