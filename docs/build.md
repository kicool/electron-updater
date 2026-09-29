# 如何构建 / 运行这个 Electron 应用

本文档让**任何人**（开发者或使用者）都能从源码把这个 Electron 应用跑起来。
更新方案本身依赖「源码运行 + git-pull」，所以构建 = 装依赖 + 启动，无需打包 asar。

## 1. 前提条件

| 依赖 | 版本 / 说明 |
|---|---|
| Node.js | ≥ 18（本机用 22.x 验证） |
| Git | 任意较新版本 |
| GitHub 访问 | 公开库可直接 clone；私有库需 SSH key 或 PAT（见 README「前置：GitHub 认证」） |
| 网络 | 首次 `npm install` 要下载 Electron 运行时（~100MB，按平台+架构缓存） |

## 2. 获取源码

- **使用者**：不用手动 clone，直接跑安装脚本（只拉 `release` 单分支）：
  ```bash
  bash scripts/setup.sh
  ```
- **开发者**：clone 整个仓库（含 `master`）：
  ```bash
  git clone git@github.com:kicool/electron-updater.git
  cd electron-git-pull-updater
  ```

## 3. 安装依赖

```bash
npm install
```
会安装 `devDependencies.electron`（本仓库锁定 `^44.4.5`）。
首次安装时 Electron 会下载匹配你**平台 + 架构**的二进制到缓存目录
（macOS：`~/Library/Caches/electron`；Linux：`~/.cache/electron`），下载过一次后续不再下。

> 卡在 `Downloading Electron binary...` 不动？通常是网络问题。可改用本机已有的
> Electron 缓存，或用环境变量 `ELECTRON_OVERRIDE_DIST_PATH` 指向一份已解包的 Electron。

## 4. 运行（源码模式）

```bash
npm start          # 等价于 `electron .`，Electron 读取 package.json 的 main 字段
```
`package.json` 中 `"main": "src/application/main.js"`，因此 Electron 启动主进程：
解析 `release` 工作树 → 启动即检测/pull 更新 → `loadFile` 加载 `src/application/renderer/index.html`。

窗口出现即表示构建成功。

## 5. 更新机制是怎么「构建」进应用的

更新能力不是额外插件，而是应用本身的代码：

- `src/application/updater.js`：纯 git 引擎（`fetch`/`compare`/`diff`/`pull`/`reset --hard`），
  **不依赖 electron**，可单独 `node` 测试。
- `src/application/main.js`：启动时调用 updater 检测 `origin/release`，落后则拉取；
  按 `git diff` 结果决定「无重启 reload」还是「提示重启」。
- `src/application/renderer/`：会被热更新的渲染层；改这里 → 用户侧无重启生效。

也就是说，**应用从 GitHub 仓库本身「构建」出更新能力**——没有单独的更新服务器。

## 6. 打包 / 分发（当前方案的限制）

本方案刻意采用**源码运行**（`electron .`）而非打包 asar，原因：

- git-pull 更新依赖「按文件 diff」判断热更范围；asar 把文件打成单包后无法做文件级 `diff`，
  会退化为「整体替换 + 必重启」，丧失无重启热更优势。
- 因此**放弃签名 / asar / 商店分发**，适合团队内部、能装 git、可信网络的场景。

若未来必须分发安装包，可选路径（超出本骨架）：
- 仅打包壳（`main/updater/preload` 进 asar），渲染层仍走 git-pull（需改加载路径与判定）；
- 或用 `electron-builder` / `electron-forge` 做一次性分发包，更新改走 `electron-updater` 官方 generic provider（与本仓库的 git 机制二选一）。

## 7. 常见问题

- **`Cannot find module`**：`package.json` 的 `main` 字段必须指向 `src/application/main.js`。若从旧结构迁移，重跑 `bash scripts/setup.sh` 会重建 `config.json` 与目录。
- **启动后界面停在「初始化…」**：多为首次 `fetch GitHub` 的网络延迟；确认 SSH 已配好（`ssh -T git@github.com`）。
- **改了主进程代码不生效**：主进程改动需**重启应用**（`npm start` 重开窗口），不是无重启热更——只有 `src/application/renderer/` 下的改动才热更。
