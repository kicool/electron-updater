#!/usr/bin/env bash
# 验收切换器（1 份化）：写 config.json 指向要验的目录 → 启动应用。
# 两档对应开发侧与用户侧；不再建 worktree —— 那份目录本来就是多余的。
#
# 用法:
#   bash scripts/verify.sh dev                 # V1：加载主仓自身（master，不联网）
#   bash scripts/verify.sh user                # V3：准备用户目录（默认 ../electron-updater-user）
#   bash scripts/verify.sh user --dir <path>   # 指定用户目录
#   bash scripts/verify.sh user --at <sha>     # 把用户目录回退到旧版本，用于验「更新过程」
#   bash scripts/verify.sh dev --no-start      # 只准备环境并打印判据，不启动窗口
#
# 共同判据：界面抬头必须显示预期的「树」和「根目录」，否则加载错了树，后面看到的都不算数。
set -eo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"

MODE="${1:-}"
if [ -z "$MODE" ]; then
  echo "用法: bash scripts/verify.sh <dev|user> [--dir <path>] [--at <sha>] [--no-start]"
  exit 1
fi
shift
NO_START=0
AT=""
USER_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-start) NO_START=1 ;;
    --at) AT="${2:-}"; shift ;;
    --dir) USER_DIR="${2:-}"; shift ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
  shift
done

# 清掉 1 份化之前留下的 dev-master / dev-release worktree（它们现在是多余的第二份）
cleanup_worktrees() {
  local wt
  for wt in "$HERE/local/dev-master" "$HERE/local/dev-release"; do
    if [ -d "$wt" ]; then
      echo "   清掉旧 worktree $wt"
      git -C "$HERE" worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"
    fi
  done
  git -C "$HERE" worktree prune
  if [ -d "$HERE/local" ] && [ -z "$(ls -A "$HERE/local" 2>/dev/null)" ]; then
    rmdir "$HERE/local"
  fi
}

write_cfg() {
  local file="$1" repo_path="$2" label="$3" branch="$4" autopull="$5" skipupdate="$6"
  cat > "$file" <<JSON
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
    echo "== V1 开发自验：加载主仓自身（master）=="
    echo "   （1 份化：主仓就是加载树，不再另开 worktree）"
    cleanup_worktrees
    write_cfg "$HERE/src/application/config.json" "$HERE" "主仓 / V1 开发自验" master false true
    echo ""
    echo "判据：抬头 树=主仓 / V1 开发自验"
    echo "      根目录 $HERE"
    echo "      preload 应为 src/application/preload.js（树内，不再带 ../）"
    echo "      autoPull=关、skipUpdate=开（不联网，只看本地代码）"
    ;;

  user)
    TARGET="${USER_DIR:-$(cd "$HERE/.." && pwd)/electron-updater-user}"
    if [ ! -d "$TARGET" ]; then
      echo "❌ 用户目录不存在: $TARGET"
      echo "   先建：git clone -b release <仓库URL> $TARGET"
      exit 1
    fi
    TARGET="$(cd "$TARGET" && pwd)"
    echo "== V3 用户态验收：准备用户目录 $TARGET =="
    if [ -n "$AT" ]; then
      echo "   回退到 $AT（模拟用户停在旧版本）"
      git -C "$TARGET" reset --hard "$AT"
    fi
    write_cfg "$TARGET/src/application/config.json" "$TARGET" "用户目录 / V3 用户态" release true false
    echo ""
    echo "判据：抬头 树=用户目录 / V3 用户态"
    echo "      根目录 $TARGET"
    echo "      autoPull=开、skipUpdate=关（真实联网）"
    if [ -n "$AT" ]; then
      echo "      启动后应看到：自动 pull → 版本号变化 → （纯渲染层）无重启热更 / （壳改动）提示重启"
    else
      echo "      提示：要验「更新过程」请加 --at <旧sha>，否则已是最新，只会显示「已是最新」"
    fi
    echo ""
    echo "   启动（必须在目标目录里跑，壳与加载树同源）："
    echo "     cd $TARGET && npm start"
    if [ -d "$TARGET/local/app-checkout" ]; then
      echo ""
      echo "   注：$TARGET/local/app-checkout 是 1 份化之前的旧加载树，已不再被使用，可自行删除。"
    fi
    echo ""
    echo "== config.json（写在目标目录）=="
    cat "$TARGET/src/application/config.json"
    exit 0
    ;;

  *)
    echo "未知档位: $MODE（只能是 dev / user）"
    exit 1
    ;;
esac

echo ""
echo "== config.json =="
cat "$HERE/src/application/config.json"

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
