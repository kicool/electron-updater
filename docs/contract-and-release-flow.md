# 文件契约与分支工作流（方案）

> 适用版本：`kicool/electron-updater` @ master（含 registry 契约注册表重构）
> 状态：方案已落地，测试矩阵未完成（见第 8 节）

---

## 0. 一句话结论

这个方案**没有编译器、没有打包器、没有类型检查**，所以「路径」和「API 名」就是它的全部契约，
而且全部**只在运行时兑现**——写错不会有任何东西拦你，只会白屏或静默崩溃。
因此本方案做两件事：**把能集中的契约全部集中到一处**，**把集中不了的用机器校验兜住**。

---

## 1. 为什么契约是这个方案的命门

传统分发：源码 → 编译/打包 → 产物。契约错位会在构建阶段暴露。
本方案：GitHub 仓库 → `git pull` → 直接加载源码。**没有构建这道闸**，错 Srting 直接进用户机器。

后果是三条：

1. 改一个文件名、挪一个目录，git 会高高兴兴推上去，用户下一秒白屏；
2. 「能不能免重启」取决于文件**放在哪个目录**，而不是取决于代码写了什么；
3. `preload.js` 属于壳、**不参与热更**，所以 pull 之后「渲染层是新的、桥是旧的」——
   新版 renderer 调用旧版 `window.api` 没有的方法，就是 `undefined is not a function`。

   > **1 份化（`4f4504f`）后本条的根因被消除**：加载树 = 仓库自身，preload 落在树内
   > （抬头实测：`../../src/application/preload.js` → `src/application/preload.js`），
   > 与 renderer、registry 三者同源、同一次 pull。
   > 风险从「结构性错配」降级为「同一批更新内的加载时序」（preload 改动是否需重启，待实测）。

第 3 条是整套设计里风险最高的一处，也是下面三道闸门主要守的东西。

---

## 2. 分层配置模型

| 层 | 文件 | 是否进 git | 内容 |
|---|---|---|---|
| 静态契约 | `src/application/registry.json` | ✅ 进 | 路径、`bridgeApi` 名单、开关默认值 |
| 本机差异 | `src/application/config.json` | ❌ gitignore | `repoPath` 绝对路径、本机 `branch` / `autoPull` 覆盖 |
| 解析器 | `src/application/registry.js` | ✅ 进 | 合并两者、推导前缀、导出绝对路径、内置校验 |

**设计原则**：凡是「与机器无关」的，一律进 `registry.json`；凡是因为装在不同目录而必须不同的，
一律留在 `config.json`。这样 dev 与 release 的契约部分**物理上就是同一份文件**，不可能不一致。

`registry.json` 当前内容（唯一事实源）：

```json
{
  "remote": "origin",
  "branch": "release",
  "useWorktree": false,
  "autoRestart": false,
  "autoPull": true,
  "paths": {
    "repoPath": "..",
    "preload": "preload.js",
    "appEntry": "src/application/renderer/index.html",
    "rendererDir": "src/application/renderer",
    "rendererEntry": "src/application/renderer/renderer.js"
  },
  "bridgeApi": ["checkUpdate", "applyUpdate", "relaunch", "onStatus", "onConfig"]
}
```

### 两个根目录（最容易踩）

```
shellDir = src/application/…      壳自身所在目录   → preload       相对它解析
repoRoot = appRoot（代码树根）      应用加载的根     → appEntry / rendererDir 相对它解析
```

布局一致但**语义不同**，混用会在 worktree 模式下出错。已写进 `registry.js` 头部注释。

---

## 3. 三道机器校验（写错就当场炸，而不是白屏）

| # | 位置 | 校验内容 | 触发时机 |
|---|---|---|---|
| 1 | `registry.js` | `appEntry` 必须落在 `rendererDir` 内——否则「改动全在渲染层 → 免重启」的前提不成立 | `require` 时 |
| 2 | `main.js` 的 `verifyContract()` | `appEntry` / `rendererDir` / `preload` 三个路径必须真实存在 | 窗口创建前，失败弹 `dialog.showErrorBox` 并退出 |
| 3 | `preload.js` | `bridgeApi` 名单与实际实现**双向一致**：声明未实现 → 抛错；实现未登记 → 也抛错 | `require` 时 |

第 3 条尤其重要：它把「偷偷扩张 API 面」和「忘了实现某个 API」都变成了启动失败，
而不是等 renderer 调用时才炸。

这三道都已实测：正向（一致时正常加载）+ 双向反向（两种不一致都被拦住）+ appEntry 越界被拦。

---

## 4. 搬不动的两处（只能靠约定）

1. `package.json → main`：Electron 在**你任何 JS 执行之前**就读它，无法配置化。
2. 注册表文件自身的路径：bootstrap 必须从一个已知位置起步。

承认这两处不可消除，比假装能消灭所有硬编码要诚实。

---

## 5. 开发态 vs 正式态：配置能否一样？

**能，但要分层说清楚，不能笼统地说「一样」。**

| 层 | 能否一致 | 靠什么保证 |
|---|---|---|
| 代码 | ✅ 必须一致 | `git merge master` 保证 tree 逐字节相同——本方案相对打包分发的优势 |
| 契约配置（路径 / API 名单 / 开关） | ✅ 天然一致 | `registry.json` 进 git，两边是同一份文件 |
| 运行时布局 | ✅ 应做成一致 | 加载目标必须是 **release 检出**，不能是开发树 |
| git 状态（分支名 / tag / dirty） | ❌ 不必一致 | 验证前 `reset --hard origin/release` 模拟干净用户态即可 |

**唯一需要区分的东西是本机绝对路径**，所以它单独待在 gitignore 的 `config.json` 里。

> 历史注记：早期曾把 `config.json.repoPath` 指向仓库根（正在开发的 master 工作树），
> 当时判为错误，理由是「运行时与开发树必须物理隔离」。
> **1 份化（`4f4504f`）后这条被推翻**：加载树就是仓库自己，隔离不再是前提，
> 保护改由 `updater.js` 的 dirty check 承担（见 6.3 红线第 1 条）。

---

## 6. 标准工作流（红线）

### 6.1 拓扑

```
GitHub: kicool/electron-updater
├── master    开发分支（所有改动先落这里）
└── release   用户分支（应用运行时加载 + 自动 pull 的目标）

开发者本机（两份长期目录）：
workspace.team/electron-updater/          ← master：主仓，写代码、commit、V1 自验
workspace.team/electron-updater-release/  ← release：独立 clone，merge + push + 准用户态验收

用户模拟（一份）：
workspace.team/electron-updater-user/     ← release 独立 clone，与真实用户同构
```

**三份都是独立仓库（真 `.git` 目录），互不共享引用。**
**且每一份自己就是加载树**（1 份化：`repoPath` 默认 = 仓库根），不再有第二份检出。

### 6.1.1 目录机制的选择判据：长期用 clone，临时用 worktree

| 用途 | 机制 | 理由 |
|---|---|---|
| master 主仓 | 主工作树 | 日常开发所在，1 份化后它自己就是加载树 |
| 开发侧 release | **独立 clone** | 长期存在 + 完全隔离（worktree 与主仓**共享 refs**，在其中 `fetch` 会改主仓的 `origin/release`） |
| 用户模拟 | **独立 clone** | 与真实用户同构：自有 `.git`、自有 remote、自有凭证 |
| 临时并行（跑旧版本对比等） | **git worktree，用完即删** | 省磁盘、不需 `npm install`；但共享 refs，**不要用它模拟用户** |

> 早期版本曾把 `local/dev-release` 建成 worktree、把 `local/app-checkout` 建成第二份检出，
> 导致开发侧 3 份目录、用户侧 2 份。现已收敛：clone 负责长期，worktree 只负责临时。

### 6.2 命令序列

```bash
# 1) 在 master 主仓开发并提交
cd workspace.team/electron-updater
git add -A && git commit -m "..."

# 2) V1 自验：主仓自己当加载树，抬头应显示该树身份
npm run verify dev

# 3) 到 release clone 里合并（主仓始终停在 master，一步都不动）
cd ../electron-updater-release

# 3a) ⚠️ 取「本地已验证的 master」，不是 origin/master
git fetch ../electron-updater master      # → FETCH_HEAD = 主仓 master 的当前位置
#    master 未必已 push：origin/master 可能还是旧指针，merge 它会静默漏掉本地提交。
#    实测（2026-09-29）：origin/master=c0ec640，主仓 master=58173e5，二者差 11 文件 452 行。
#    若已确认 master 已 push，则 `git fetch origin && git merge origin/master` 等价。

# 3b) 合并（需要 committer 身份 → 见 6.2.1）
git merge FETCH_HEAD

# 4) V2 判据：合并后与本地 master 逐字节一致
git diff --stat FETCH_HEAD    # 必须为空

# 5) push —— 外部动作，执行前必须确认
git push git@github.com:kicool/electron-updater.git release --tags
```

### 6.2.1 两个本机坑（均已实测）

1. **git 身份未配置**（local / global 都没有 `user.name` / `user.email`）：merge 需要 committer，
   而 `git -c` 注不进脚本内部调用 → 用**环境变量**包住：

   ```bash
   GIT_AUTHOR_NAME="AI-Test" GIT_AUTHOR_EMAIL="ai-test@AI-NativedeMacBook-Pro.local" \
   GIT_COMMITTER_NAME="AI-Test" GIT_COMMITTER_EMAIL="ai-test@AI-NativedeMacBook-Pro.local" \
   git merge origin/master
   ```

2. **https 远端推不动**：`could not read Username for 'https://github.com': terminal prompts disabled`
   （需要 PAT，keychain 里也没有凭证）；而 SSH 可用（`ssh -T git@github.com` → `Hi kicool!`）。
   → 本次直接用 SSH URL，**不改 remote 配置**。

### 6.2.2 能否免 merge

```bash
git merge-base --is-ancestor origin/release master
# 为真 → release 上没有 master 不含的提交，可 git push origin master:release 一步快进
# 为假 → 必须真 merge，否则 push 会被拒绝（非快进）
```

当前判据为**假**：release 上有 2 个 master 不含的提交（v2 演示提交 + 上一次的 merge commit），
所以**每次发版都要真 merge**。想恢复快进能力，需把 release 的独有提交先并回 master。

### 6.3 红线

1. **pull 绝不许静默毁掉用户的改动**。1 份化后加载树就是用户自己的仓库根目录，
   保护手段从「物理隔离」换成**机制**：`updater.js` 的 `isDirty()`
   （`git status --porcelain --untracked-files=no`）在 pull 前检查，有 tracked 改动就拒绝拉取并回报。
   > 旧红线「绝不能把 `repoPath` 指向正在开发的树」已被本条取代：
   > 隔离不再是前提，**兜底才是**。只看 tracked 是刻意的——`reset --hard` 只抹 tracked，
   > 拦 untracked 属于过度保护（受控实验已验证：reset 后 untracked 文件仍在）。
2. 先验证、后合并；**测试没做完就不要把改动并进 release**。
3. `push origin release --tags` 属于外部动作，执行前必须确认。
4. 版本号来自 `git describe --tags`，发版要打 tag，否则 UI 只显示短 sha。
5. **不要在用户模拟目录（`electron-updater-user`）里做 merge / commit** —— 会污染验收环境，
   开发侧的 release 操作一律在 `electron-updater-release` 里做。
6. release clone 里 merge **前必须先取到主仓 master 的真实位置**（`git fetch ../electron-updater master`，
   或确认已 push 后 `git fetch origin`）。**不要盲信 `origin/master`** —— 它可能是旧指针（见 6.2 第 3a 步）。
   这也是独立 clone 相对 worktree 的代价：clone 看不到主仓的本地分支，worktree 能（但共享 refs）。

---

## 7. 已收敛的重复

| 原本散落处 | 现在 |
|---|---|
| `main.js` 的 `loadConfig()` 里一整套默认 path | `registry.json` |
| `preload.js` 里手写 `window.api` 成员 | 由 `bridgeApi` 名单生成 |
| `setup.sh` heredoc 重写整个 config 形状 | 只写本机差异 4 个键 |
| `publish.sh` 硬编码 `src/application/renderer/renderer.js` | 向 registry 询问 |
| 热更判定前缀（曾由 `path.dirname(appEntry)` 推导） | `rendererPrefix`，来自 `rendererDir` |

---

## 8. 测试矩阵（未完成，当前最高优先级）

| # | 用例 | 状态 |
|---|---|---|
| T1 | 契约校验 + registry 解析 | **已过**（V1 抬头实测：`[contract]` 打印 + 窗口正常） |
| T2 | `npm run selftest` | 已过 |
| T3 | **渲染层无重启热更**：改 renderer → 界面自动刷新 | **未验证**（方案核心卖点，需一次纯渲染层改动 + 真实 push） |
| T4 | 壳改动 → 提示需重启 → `relaunch()` | 环境已就绪：用户树已回退到 `103e1b2`，node 侧预测 `onlyRendererChanges=false` → 应提示重启；**待用户跑 `npm start` 确认** |
| T5 | `autoPull=false` 仅提示 + 「更新」按钮 | 未验证 |
| T6 | 离线降级（远端不可达） | 未验证 |
| T7 | 全新安装：`setup.sh` → `npm start` | 未验证 |
| T8 | Electron 二进制缓存对齐（`electron-once.sh`） | **已过**：官方 / npmmirror 两个真实 URL 全部命中，硬链接共享 inode，占用恒 592M |
| T9 | preload 沙箱（Electron 20+ 默认 `sandbox: true` 致 `require('./registry')` 抛错） | **已修并验过**：`webPreferences` 加 `sandbox: false`，V1 截图确认 `window.api` 恢复 |

T3 / T4 需要真实 push 到 GitHub release 分支，属外部动作。
T4 的当前环境：`/Users/aidev/workspace.team/electron-updater-user`（加载树已回退到 `103e1b2`）。

---

## 9. 环境已知坑

| 现象 | 根因 | 处理 |
|---|---|---|
| `ERR_REQUIRE_ESM` @ `install.js` | electron@44 要求 Node ≥ 22.12 | 用 Node 22（仓库有 `.nvmrc` + `engines`） |
| `Cannot read properties of undefined (reading 'whenReady')` | 环境存在 `ELECTRON_RUN_AS_NODE=1`，Electron 退化成普通 Node | `unset ELECTRON_RUN_AS_NODE` |
| Electron 二进制下载卡在 1%（ETA 一小时） | 未走代理；直连 github 约 1KB/s | 走系统代理 `127.0.0.1:7890`（实测 2.1MB/s） |
| `sandbox initialization failed` | 在受限进程里启动 Chromium | 临时 `--no-sandbox`（仅排障用） |

---

## 10. 后续 TODO

- [x] **「1 份化」改造**（`4f4504f`，已完成）：用户侧 1 份目录、开发侧 2 份，加载树 = 仓库自身
      - [x] `registry.json` 默认 `repoPath` = `..`（仓库根）→ preload 从树外回到树内
      - [x] `updater.js` 新增 `isDirty()`：pull 前查 tracked 改动，有则拒绝（含受控实验验证）
      - [x] `setup.sh` 不再 clone 第二份，只写 `config.json`
      - [x] `verify.sh` 三档 → 两档（`dev` = 主仓自身 / `user` = 指定用户目录 + `--at`）
      - [x] 清掉遗留的 `local/dev-master` / `local/dev-release` worktree
      - [ ] **待验**：V1 窗口抬头显示 preload 树内；V3 用户态自动 pull（需先 push release + 用户目录同步）
      - 连带收益已兑现：renderer / preload / registry 三者同源、同一次 pull（第 1 节第 3 条已改写）
- [ ] 实测「preload 改动是否 reload 即生效」（1 份化后它进了 pull 覆盖范围，理论上 reload 会重读文件，
      **未实测**；若成立则 preload 类改动无需重启，热更判据可放宽）
- [ ] 给 renderer 加轻量 manifest，声明所需 bridge API 版本，由 preload 启动时比对（目前只校验名单一致，未做版本协商）
- [ ] `package.json` 变更后自动 `npm ci` + 重启（目前是契约缺口）
- [ ] 跑完第 8 节测试矩阵并回填结果
- [ ] 决定 git 身份：是配置一次 `git config user.name/email`，还是继续每次 `-c` / 环境变量单次指定
      （当前沿用 `AI-Test <ai-test@AI-NativedeMacBook-Pro.local>`）
