#!/usr/bin/env bash
# 用户首次安装：只 clone 真实 GitHub 仓库的【release 分支】(单分支，不含 master)，
# 写 config.json（useWorktree=false，应用直接加载这个 release 工作树）。
# 设计原则：默认用户只跑不开发 → 只拿 release；开发态(master worktree)与本升级方案解耦，
# 开发者自行用 git worktree 拉出（见 README「本地开发」一节），updater.js 等代码不体现 master。
# 用法:
#   bash scripts/setup.sh                              # 默认 SSH: git@github.com:kicool/electron-updater.git
#   bash scripts/setup.sh git@github.com:OWNER/REPO.git
#   私有库也可用 HTTPS+PAT: GITHUB_TOKEN=ghp_xxx bash scripts/setup.sh https://github.com/OWNER/REPO.git
set -eo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO_URL="${1:-git@github.com:kicool/electron-updater.git}"
BRANCH="${2:-release}"
LOCAL="$HERE/local/app-checkout"
TOKEN="${GITHUB_TOKEN:-}"

# 私有库：把 token 注入 https URL（仅 https 时生效）
if [ -n "$TOKEN" ] && [[ "$REPO_URL" == https://* ]]; then
  CLONE_URL="https://${TOKEN}@${REPO_URL#https://}"
else
  CLONE_URL="$REPO_URL"
fi

echo "== 1) 只 clone 远程 $BRANCH 分支（单分支，不含 master）=="
rm -rf "$LOCAL" "${LOCAL}.release"   # 清掉旧 clone 及可能的旧 worktree，保证干净起点
if ! git clone -b "$BRANCH" --single-branch "$CLONE_URL" "$LOCAL"; then
  echo "❌ clone $BRANCH 失败：远端大概率还没有 $BRANCH 分支。"
  echo "   请先在 GitHub 上创建并推送 $BRANCH 分支（用 scripts/publish.sh 或网页发版）。"
  exit 1
fi
cd "$LOCAL"
git config user.email "${GIT_USER_EMAIL:-user@local}"
git config user.name  "${GIT_USER_NAME:-user}"

echo "== 2) 写 src/application/config.json（useWorktree=false，直接加载 release 工作树）=="
cat > "$HERE/src/application/config.json" <<JSON
{
  "repoPath": "$LOCAL",
  "branch": "$BRANCH",
  "remote": "origin",
  "appEntry": "src/application/renderer/index.html",
  "useWorktree": false,
  "autoRestart": false,
  "autoPull": true
}
JSON

echo ""
printf '✅ 已 clone %s 的 %s 分支到 %s，config.json 已写好（useWorktree=false）。\n' "$REPO_URL" "$BRANCH" "$LOCAL"
echo "   启动:                   cd $HERE && npm install && npm start"
echo "   发版(A 角色, 独立操作):  bash scripts/publish.sh $REPO_URL"
echo ""
echo "   想本地开发? 与本升级方案无关，开发者自行:"
echo "     cd $LOCAL"
echo "     git fetch origin master:master          # 单分支 clone 默认不含 master，先取回"
echo "     git worktree add ../dev-master master    # 拉出开发用 master 工作树"
echo "   （updater.js 永远只认 release 工作树，master 工作树与它互不干扰）"
