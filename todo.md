# 后续待办（P0+P1 发版收尾）

> 目标：把 master 上已提交的 P0+P1 批次推到 release，并把 **master 和 release 两条分支都同步到远端**，最后在用户目录做 V3 验收。
> 本文只做清单与判据；**每一步都要拿到上一步的判据通过才继续**。

## 0. 当前状态快照（2026-09-30 02:05 实测）

| 位置 | 分支 | HEAD | 说明 |
|---|---|---|---|
| `electron-updater`（主仓，开发） | master | `7b83d4c` | ✅ 已 push 到远端（`c0ec640` → `7b83d4c`） |
| `electron-updater` | release | `698d73e` | 本地 release 分支已落后，**本轮不用它**（发版操作一律在 release clone 里做） |
| `electron-updater-release`（开发侧 release clone） | release | `fa6a53c` | ✅ 已 merge 并 push（`547b7d4` → `fa6a53c`），工作树干净 |
| `electron-updater-user`（用户模拟） | release | `547b7d4` | 待 pull：远端 release 已是 `fa6a53c` |

远端：`origin = https://github.com/kicool/electron-updater`（主仓 remote）。
⚠️ https 推不动（`terminal prompts disabled`），SSH 可用 → **push 一律显式用 `git@github.com:kicool/electron-updater.git`，不改 remote 配置**。

---

## 一、commit（✅ 已完成）

```bash
cd workspace.team/electron-updater
git add -A
git -c user.name="AI-Test" -c user.email="ai-test@AI-NativedeMacBook-Pro.local" commit -F <msg>
```

- 提交号 **`5a651c5`** — `feat: P0+P1 更新契约加固 + 校验工具链`，22 文件 +2719/−101。
- 提交号 **`7b83d4c`** — `docs: 增加发版收尾待办清单`，`todo.md`。
- 提交前自验（全绿）：`core-test` 61 条、`matrix-test` 策略 103680 + 界面 192 组合 0 违反、`contract-check` 100% 覆盖、`smoke` 通过。
- 工作树已干净：`git status --short` 无输出。

**未完成**：V1 的人眼验收（界面抬头契约版本 1.1.0 / 三分区布局 / 开机三选下拉 / 标题 Electron Updater Toolkit）。

---

## 二、merge 到 release（✅ 已完成 → `fa6a53c`）

```bash
cd ../electron-updater-release

# 2a) 取「本地已验证的 master」，不要盲信 origin/master（它可能是旧指针）
git fetch ../electron-updater master        # → FETCH_HEAD = 主仓 master 的真实位置（本次 7b83d4c）

# 2b) 合并（需要 committer 身份；本机 git 身份未配置 → 用环境变量包住）
GIT_AUTHOR_NAME="AI-Test" GIT_AUTHOR_EMAIL="ai-test@AI-NativedeMacBook-Pro.local" \
GIT_COMMITTER_NAME="AI-Test" GIT_COMMITTER_EMAIL="ai-test@AI-NativedeMacBook-Pro.local" \
git merge FETCH_HEAD
```

**判据（V2，必须成立才继续）**：

```bash
git diff --stat FETCH_HEAD    # 必须为空 → 合并结果与主仓 master 逐字节一致
```

本次结果：**判据通过**（`git diff --stat FETCH_HEAD` 无输出），merge 提交 `fa6a53c`。

补充判据（可选，确认是否可快进）：

```bash
git merge-base --is-ancestor origin/release master   # 为真才可 git push origin master:release 一步快进
```

> 当前为**假**：release 上有 master 不含的提交（v2 演示提交 + 上次 merge commit），所以**每次都要真 merge**。

---

## 三、push 两条分支到远端（✅ 已完成）

实测结果：`release 547b7d4 → fa6a53c`、`master b26c409 → 7b83d4c`。

### 3.1 push release

```bash
cd ../electron-updater-release
git push git@github.com:kicool/electron-updater.git release --tags
```

### 3.2 push master

```bash
cd ../electron-updater                                # 主仓
git push git@github.com:kicool/electron-updater.git master
```

### 3.3 打 tag（❌ 已决定：本轮不打）

版本号来自 `git describe --tags`，**不打 tag 则 UI 只显示短 sha** —— 本次接受，后续要版本号再补：

```bash
git tag -a v1.1.0 -m "contract 1.1.0：更新单元白名单 + 时机策略引擎"
git push git@github.com:kicool/electron-updater.git v1.1.0
```

> 补 tag 后已发布的用户需 pull 一次才能在抬头看到版本号（`git describe` 依赖本地 tag/历史）。

### 判据

```bash
git ls-remote git@github.com:kicool/electron-updater.git refs/heads/master refs/heads/release
# master 应为 7b83d4c，release 应为 fa6a53c（本次已核对一致）
```

推完回到主仓刷新引用：`git fetch origin`（主仓的 `origin/release` 曾是陈旧指针 `698d73e`，刷新后为 `fa6a53c`）。

---

## 四、用户侧 pull 与 V3 验收

```bash
cd ../electron-updater-user
git pull --ff-only origin release
npm run verify user -- --dir /Users/aidev/workspace.team/electron-updater-user
```

V3 要看的：自动 pull / 重启提示 / 更新类别判定（hot → 无重启 reload；触及壳或 `package.json` → 提示重启）。
⚠️ 用户目录**只 pull，不 merge、不 commit**。

---

## 五、未决项（本轮不解决，单独排期）

| # | 事项 | 现状 |
|---|---|---|
| 1 | **旧壳过渡期缺 `isDirty` 保护** —— 执行更新的是旧壳（如 `698d73e`），旧版还没 `isDirty`，那一跳无保护 | 待设计方案 |
| 2 | ~~是否打 tag~~ | **本轮决定不打**：UI 显示短 sha，后续补 tag 时用户需再 pull 一次 |
| 3 | `deps` 单元（`node_modules` 变更）的 `npm ci` 默认不自动开 | 待 V3 实测 |
| 4 | 真实断网下的退避与重连、小时级定时触发 | 需长时间跑，V3 之后 |
| 5 | `apply=notify` 的真实按钮流程 | V3 用户态验 |

---

## 六、生产待验证功能

> 以下功能在临时仓库或单元测试中验证过，但**未在真实代码仓库（electron-updater）中应用过**。
> 需要在真实环境中验证后才能标记为完成。

| # | 功能 | 验证方式 | 状态 |
|---|---|---|---|
| 1 | **D1: npm ci 移到 pull 之后** | 临时仓库验证通过；待真实项目验证 | ⬜ 待验证 |
| 2 | **D2/D4: aheadBehind 检查** | 单元测试通过；待真实项目验证 | ⬜ 待验证 |
| 3 | **D3: require 移到文件顶部** | grep 检查通过；待真实项目验证 | ⬜ 待验证 |

### 验证清单

- [ ] 在真实项目（electron-updater）中执行一次完整更新，验证 npm ci 在 pull 之后执行
- [ ] 在真实项目中模拟本地有未推送 commit，验证 aheadBehind 检查生效
- [ ] 在真实项目中验证 require 全部在文件顶部，无延迟 require

---

## 七、红线速查

1. 先验证、后合并；**测试没做完就不要并进 release**。
2. push 属外部动作，**执行前必须确认**（尤其是 `--tags`）。
3. 发版操作一律在 `electron-updater-release` 里做，**不要动 `electron-updater-user`**。
4. merge 前必须先取到主仓 master 的真实位置，别盲信 `origin/master`。
5. 本机无 git 身份配置：提交用 `git -c user.name/email`，merge 用 `GIT_AUTHOR_*`/`GIT_COMMITTER_*` 环境变量。
