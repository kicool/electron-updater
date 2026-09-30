#!/usr/bin/env bash
# 用户首次安装（1 份化）：本目录本身就是加载树，不再 clone 第二份。
# 只做两件事：写 config.json（指向仓库根）+ 对齐 Electron 二进制缓存。
#
# 用法:
#   bash scripts/setup.sh                  # 默认跟随 release 分支
#   bash scripts/setup.sh <branch>         # 指定要跟随的分支
#
# 前提：本目录已经是从远端 clone 下来的仓库（用户拿到的是 release 分支）。
# 与旧版的区别：旧版在这里 clone 一份到 local/app-checkout，导致用户侧两份目录。
set -eo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$HERE/src/application/config.json"
BRANCH="${1:-release}"

if [ ! -d "$HERE/.git" ]; then
  echo "❌ $HERE 不是 git 仓库。1 份化后不再单独 clone 加载树，请先 clone 仓库本身："
  echo "   git clone -b $BRANCH <仓库URL> <目录> && cd <目录> && bash scripts/setup.sh"
  exit 1
fi

echo "== 1) 本目录即加载树（不再有第二份）=="
echo "   目录 $(git -C "$HERE" rev-parse --show-toplevel)"
echo "   分支 $(git -C "$HERE" rev-parse --abbrev-ref HEAD) @ $(git -C "$HERE" rev-parse --short HEAD)"

echo ""
echo "== 2) 写 src/application/config.json（只放本机差异，其余契约取自 registry.json）=="
cat > "$CFG" <<JSON
{
  "repoPath": "$HERE",
  "branch": "$BRANCH",
  "remote": "origin",
  "useWorktree": false
}
JSON
cat "$CFG"

echo ""
echo "== 3) 对齐 Electron 二进制缓存（避免同一份 130MB 被重复下载）=="
bash "$HERE/scripts/electron-once.sh" || true

echo ""
printf '✅ 配置完成：应用将加载本目录自身（%s）\n' "$HERE"
echo "   ⚠️ 本目录不能再放未提交的改动：更新用 reset --hard，会抹掉 tracked 改动。"
echo "      （启动时主进程会做 dirty check：有改动则拒绝自动拉取并提示，不会静默毁掉）"
echo "   启动: cd $HERE && npm install && npm start"
