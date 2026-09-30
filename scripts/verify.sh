#!/usr/bin/env bash
# 验收切换器：准备「加载树」→ 写 config.json（含 treeLabel）→ 启动应用。
# 三档对应验收的三个阶段，界面顶部「加载环境」抬头会显示当前档位与路径。
#
# 用法:
#   bash scripts/verify.sh dev                # V1 开发自验：加载 local/dev-master（分离头 master，不联网拉取）
#   bash scripts/verify.sh merge              # V2 合并验：加载 local/dev-release（release + merge master）
#   bash scripts/verify.sh user               # V3 用户态：加载 local/app-checkout（单分支 release，与用户同构）
#   bash scripts/verify.sh user --at <sha>    # 先把用户树回退到旧版本再启动，用于验「更新过程」
#   bash scripts/verify.sh dev --no-start     # 只准备环境并打印判据，不启动窗口
#
# 共同判据：界面抬头必须显示预期的「树」和「根目录」，否则说明加载错了树，后面看到的都不算数。
set -eo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$HERE/src/application/config.json"

MODE="${1:-}"
if [ -z "$MODE" ]; then
  echo "用法: bash scripts/verify.sh <dev|merge|user> [--at <sha>] [--no-start]"
  exit 1
fi
shift
NO_START=0
AT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-start) NO_START=1 ;;
    --at) AT="${2:-}"; shift ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
  shift
done

# 卸载旧 worktree（若存在），保证每次都是干净起点
drop_worktree() {
  local wt="$1"
  if [ -d "$wt" ]; then
    git -C "$HERE" worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"
  fi
  git -C "$HERE" worktree prune
}

write_cfg() {
  local repo_path="$1" label="$2" branch="$3" autopull="$4" skipupdate="$5"
  cat > "$CFG" <<JSON
{
  "repoPath": "$repo_path",
  "treeLabel": "$label",
  "branch": "$branch",
  "autoPull": $autopull,
  "skipUpdate": $skipupdate
}
JSON
}

case "$MODE" in
  dev)
    WT="$HERE/local/dev-master"
    echo "== V1 开发自验：准备 dev-master（分离头 master）=="
    drop_worktree "$WT"
    git -C "$HERE" worktree add --detach "$WT" master
    # 分离头是刻意的：即使误开 autoPull，reset --hard 也只移动 HEAD，
    # 不会动 master 分支指针、不污染主工作树（比「记得关 autoPull」可靠）。
    write_cfg "$WT" "dev-master / V1 开发自验" master false true
    echo ""
    echo "判据：抬头 树=dev-master"
    echo "      根目录 $WT"
    echo "      比对分支 master @ <HEAD>（detached）"
    echo "      功能效果可见，且启动终端 [contract] 打印与预期一致"
    ;;

  merge)
    WT="$HERE/local/dev-release"
    echo "== V2 合并验：准备 dev-release（release + merge master）=="
    drop_worktree "$WT"
    git -C "$HERE" fetch origin release
    git -C "$HERE" branch -f release origin/release
    git -C "$HERE" worktree add "$WT" release
    git -C "$WT" merge --no-edit master
    write_cfg "$WT" "dev-release / V2 合并验" release false true
    echo ""
    echo "判据：抬头 树=dev-release"
    echo "      根目录 $WT"
    echo "      且 git diff master 必须为空（证明 merge 后与开发树逐字节一致）"
    echo "  实际差异："
    if git -C "$WT" diff --stat master | grep -q .; then
      git -C "$WT" diff --stat master
      echo "  ⚠️ 与 master 有差异，先查清楚再往下走"
    else
      echo "  （无差异 ✓）"
    fi
    ;;

  user)
    LOCAL="$HERE/local/app-checkout"
    echo "== V3 用户态验收：使用 app-checkout（单分支 release）=="
    if [ ! -d "$LOCAL/.git" ]; then
      echo "❌ 还没有用户树，先跑：bash scripts/setup.sh"
      exit 1
    fi
    if [ -n "$AT" ]; then
      echo "   回退到 $AT（模拟用户停在旧版本）"
      git -C "$LOCAL" reset --hard "$AT"
    fi
    write_cfg "$LOCAL" "app-checkout / V3 用户态" release true false
    echo ""
    echo "判据：抬头 树=app-checkout"
    echo "      根目录 $LOCAL"
    echo "      autoPull 开"
    if [ -n "$AT" ]; then
      echo "      启动后应观察到：自动 pull → 版本号变化 → （纯渲染层改动）无重启热更 / （壳改动）提示重启"
    else
      echo "      提示：要验「更新过程」请加 --at <旧sha>，否则树已在最新，只会显示「已是最新」"
    fi
    ;;

  *)
    echo "未知档位: $MODE（只能是 dev / merge / user）"
    exit 1
    ;;
esac

echo ""
echo "== config.json =="
cat "$CFG"

if [ ! -d "$HERE/node_modules/electron" ]; then
  echo ""
  echo "⚠️ 依赖未安装，窗口跑不起来。先执行：cd $HERE && npm install"
  exit 0
fi

if [ "$NO_START" -eq 0 ]; then
  echo ""
  echo "== 启动应用 =="
  cd "$HERE" && npm start
fi
