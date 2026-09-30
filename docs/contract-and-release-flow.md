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
    "repoPath": "../../local/app-checkout",
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

> 本项目曾犯的错（记录在案）：把 `config.json.repoPath` 指向了仓库根目录，
> 也就是正在开发的 master 工作树——而 pull 是 `reset --hard`，会抹掉未提交改动，
> 同时也违反 README「运行时与开发树物理隔离」的原则。

---

## 6. 标准工作流（红线）

### 6.1 拓扑

```
GitHub: kicool/electron-updater
├── master    开发分支（所有改动先落这里）
└── release   用户分支（应用运行时加载 + 自动 pull 的目标）

开发者本机：
<repo>/                     ← master 工作树：写代码、commit
<repo>/local/dev-release/   ← release 工作树：验证目标（git worktree add）
<repo>/local/app-checkout/  ← release 检出：模拟真实用户（setup.sh 生成）
```

**运行时只认最下面两个，永远不认最上面那个。**

### 6.2 命令序列

```bash
# 1) 在 master 上开发并提交
git add -A && git commit -m "..."

# 2) 拉出 release 验证目标（这一步不是合并，只是给应用一个和用户同构的加载目标）
git fetch origin
git worktree add local/dev-release release

# 3) config.json 指向该验证目标
#    { "repoPath": "<abs>/local/dev-release", "branch": "release", "autoPull": false }

# 4) （可选）在这棵树上预演合并后的状态
cd local/dev-release && git merge master

# 5) 跑测试矩阵（第 8 节），通过后 —— 这一步是外部动作，需确认 ——
git checkout -B release origin/release
git merge master
git push origin release --tags
```

### 6.3 红线

1. **绝不能把 `repoPath` 指向正在开发的 master 工作树**（`reset --hard` 会抹改动）。
2. 先验证、后合并；**测试没做完就不要把改动并进 release**。
3. `push origin release --tags` 属于外部动作，执行前必须确认。
4. 版本号来自 `git describe --tags`，发版要打 tag，否则 UI 只显示短 sha。

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
| T1 | 契约校验 + registry 解析 | 已过（master 树上打印 `[contract]`）；需在 release 工作树重跑 |
| T2 | `npm run selftest` | 已过 |
| T3 | **渲染层无重启热更**：`publish.sh` → 界面自动刷新为 V2 | **未验证**（方案核心卖点） |
| T4 | 壳改动 → 提示需重启 → `relaunch()` | 未验证 |
| T5 | `autoPull=false` 仅提示 + 「更新」按钮 | 未验证 |
| T6 | 离线降级（远端不可达） | 未验证 |
| T7 | 全新安装：`setup.sh` → `npm start` | 未验证 |

T3 / T4 需要真实 push 到 GitHub release 分支，属外部动作。

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

- [ ] 补 README 一套「直接在仓库根目录开发」的等价流程（现有流程假设先有 `local/app-checkout`）
- [ ] 给 renderer 加轻量 manifest，声明所需 bridge API 版本，由 preload 启动时比对（目前只校验名单一致，未做版本协商）
- [ ] `package.json` 变更后自动 `npm ci` + 重启（目前是契约缺口）
- [ ] 跑完第 8 节测试矩阵并回填结果
