#!/usr/bin/env bash
# 模拟 A 角色在【真实 GitHub】的 release 分支发布新版本（V1→V2），真实 push。
# 用法:
#   bash scripts/publish.sh                              # 默认 SSH: git@github.com:kicool/electron-updater.git
#   bash scripts/publish.sh git@github.com:OWNER/REPO.git
#   私有库也可用 HTTPS+PAT: GITHUB_TOKEN=ghp_xxx bash scripts/publish.sh https://github.com/OWNER/REPO.git
set -eo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO_URL="${1:-git@github.com:kicool/electron-updater.git}"
# 用法: bash scripts/publish.sh [github-repo-url] [branch]   （省略参数时用内置默认仓库）
BRANCH="${2:-release}"
TOKEN="${GITHUB_TOKEN:-}"
TMP="$(mktemp -d)"

if [ -n "$TOKEN" ] && [[ "$REPO_URL" == https://* ]]; then
  CLONE_URL="https://${TOKEN}@${REPO_URL#https://}"
else
  CLONE_URL="$REPO_URL"
fi

echo "== 独立 clone release 分支（模拟 A 角色机器） =="
git clone -q "$CLONE_URL" "$TMP/repo"
cd "$TMP/repo"
git config user.email "${GIT_USER_EMAIL:-a@local}"
git config user.name  "${GIT_USER_NAME:-A 角色}"
git checkout -B "$BRANCH" "origin/$BRANCH"

# renderer 入口路径不写死，向 registry.json 问（契约唯一事实源）
RENDERER_ENTRY="$(node -e "console.log(require('$HERE/src/application/registry.js').rendererEntry)")"

echo "== 把功能版本标记 V1→V2（真实场景是改业务代码） =="
node -e "const fs=require('fs');const p='$RENDERER_ENTRY';let s=fs.readFileSync(p,'utf8');s=s.replace(/FEATURE_VERSION = \"V\\d+\"/,'FEATURE_VERSION = \"V2\"');fs.writeFileSync(p,s)"

git add -A
git commit -q -m "release: feature V2（模拟 A 角色发布）"
git tag v1.1.0
git push -q origin "$BRANCH" --tags

rm -rf "$TMP"
echo "✅ 已发布 v1.1.0（FEATURE_VERSION=V2）到真实 GitHub: $REPO_URL"
echo "   切回运行中的应用，点『检查更新』，即可看到无重启热更新。"
