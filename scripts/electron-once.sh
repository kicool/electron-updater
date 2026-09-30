#!/usr/bin/env bash
# Electron 二进制「最多下一次」——缓存对齐器（本脚本永不下载，只查找/链接）
#
# 背景（读源码确认，node_modules/@electron/get/dist/Cache.js:16）：
#   缓存目录名 = sha256(下载 URL 去掉文件名后的部分)
#   => 只要镜像域名/路径一变，即便 zip 字节完全相同，也算新条目，重新下一次 130MB。
#   实测本机缓存里 44.4.5 有两份（c8c564d0 09-27 / bfa62fe1 09-29）、42.3.0 也有两份，
#   正是不同来源 URL 造成的。
#
# 本脚本做三件事（都不联网）：
#   1) 复刻 @electron/get 的算法，算出「当前配置会请求的 URL」对应的缓存目录；
#   2) 已命中 → 报告，npm install 不会再下载；
#   3) 未命中 → 在缓存里找同名 + 内容 sha256 一致的 zip，硬链接过去（同 inode，零额外磁盘）；
#      这样即使你以后换了镜像，也不会重下一次。
#
# 用法:
#   bash scripts/electron-once.sh                      # 对齐「当前配置」的 URL
#   bash scripts/electron-once.sh --mirror <base-url>  # 顺手为某个镜像也备好（不改动任何配置）
#   bash scripts/electron-once.sh --list               # 只看缓存里现在有什么
set -eo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

# ---------- 缓存根目录（与 @electron/get 一致：env-paths('electron').cache）----------
case "$(uname -s)" in
  Darwin) DEF_CACHE="$HOME/Library/Caches/electron" ;;
  *)      DEF_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/electron" ;;
esac
CACHE="${electron_config_cache:-${ELECTRON_CACHE:-$DEF_CACHE}}"

# ---------- sha256 工具 ----------
if command -v shasum >/dev/null 2>&1; then
  sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha_of() { sha256sum "$1" | awk '{print $1}'; }
else
  sha_of() { node -e 'const c=require("crypto"),f=require("fs");const h=c.createHash("sha256");h.update(f.readFileSync(process.argv[1]));process.stdout.write(h.digest("hex"))' "$1"; }
fi

# ---------- 复刻 @electron/get 的缓存目录算法（传完整 URL，让它自己剥文件名）----------
hash_of_url() {
  node -e '
    const crypto = require("crypto");
    const posix  = require("path").posix;
    const u = new URL(process.argv[1]);
    u.hash = ""; u.search = "";
    u.pathname = posix.dirname(u.pathname);      // 关键：文件名不参与 hash
    process.stdout.write(crypto.createHash("sha256").update(u.toString()).digest("hex"));
  ' "$1"
}

echo "== Electron 二进制缓存对齐（不联网、不下载）=="
echo "缓存根目录: $CACHE"
if [ ! -d "$CACHE" ]; then
  echo "   （目录尚不存在，首次 npm install 会真实下载一次，之后复用）"
  exit 0
fi

# ---------- 版本 / 平台 / 架构 ----------
if [ -f node_modules/electron/package.json ]; then
  VER="$(node -p "require('./node_modules/electron/package.json').version" 2>/dev/null || true)"
fi
if [ -z "${VER:-}" ]; then
  VER="$(node -p "const p=JSON.parse(require('fs').readFileSync('package.json','utf8'));(p.devDependencies&&p.devDependencies.electron||'').replace(/^[\^~]/,'')" 2>/dev/null || true)"
fi
if [ -z "$VER" ]; then echo "❌ 读不到 electron 版本"; exit 1; fi
PLAT_ARCH="$(node -p "process.platform + ' ' + process.arch")"
PLAT="${PLAT_ARCH%% *}"
ARCH="${PLAT_ARCH##* }"
FILE="electron-v${VER}-${PLAT}-${ARCH}.zip"
echo "目标文件  : $FILE"

# ---------- 镜像（环境优先，默认官方；与 artifact-utils.js 的 mirrorVar 顺序一致）----------
BASE="${npm_config_electron_mirror:-${NPM_CONFIG_ELECTRON_MIRROR:-${ELECTRON_MIRROR:-}}}"
[ -n "$BASE" ] || BASE="https://github.com/electron/electron/releases/download/"
[ "${BASE: -1}" = "/" ] || BASE="$BASE/"

if [ "${1:-}" = "--list" ]; then
  echo ""
  echo "== 缓存现存条目 =="
  for d in "$CACHE"/*/; do
    [ -d "$d" ] || continue
    for f in "$d"*; do
      [ -f "$f" ] || continue
      printf '  %-12s %10d 字节  %s\n' "$(basename "$d" | cut -c1-12)" "$(wc -c <"$f" | tr -d ' ')" "$(basename "$f")"
    done
  done
  echo ""
  echo "占用: $(du -sh "$CACHE" 2>/dev/null | cut -f1)"
  exit 0
fi

if [ "${1:-}" = "--mirror" ] && [ -n "${2:-}" ]; then
  EXTRA="$2"
  [ "${EXTRA: -1}" = "/" ] || EXTRA="$EXTRA/"
  BASE="$EXTRA"
  echo "（--mirror 模式：额外为 $BASE 备好，不改动任何配置）"
fi

# ---------- 候选目录：官方用 v 前缀目录，npmmirror 用无前缀目录 ----------
align() {
  local dir="$1" url hash target
  url="${BASE}${dir}/${FILE}"
  hash="$(hash_of_url "$url")"
  target="$CACHE/$hash/$FILE"
  if [ -f "$target" ]; then
    echo "  ✅ 命中: $hash/$(basename "$target")  <- $url"
    return 0
  fi
  # 未命中：找同名（文件名已含 版本+平台+架构）的已有 zip，硬链过来
  local cand=""
  for c in "$CACHE"/*/"$FILE"; do
    [ -f "$c" ] || continue
    cand="$c"
    break
  done
  if [ -n "$cand" ]; then
    local sha
    sha="$(sha_of "$cand")"
    mkdir -p "$(dirname "$target")"
    if ln "$cand" "$target" 2>/dev/null; then
      echo "  🔗 已对齐（硬链接，与源文件同一 inode，零额外磁盘）: $hash/"
    else
      cp "$cand" "$target"
      echo "  📋 已对齐（复制；跨设备无法硬链接）: $hash/"
    fi
    echo "       源: $(basename "$(dirname "$cand")")/$(basename "$cand")"
    echo "       sha256: ${sha:0:16}…"
    return 0
  fi
  echo "  ⬇️  未命中: $hash/ 尚不存在 → 首次安装会真实下载一次（之后复用）"
  echo "       URL: $url"
  return 0
}

# 目录名：index.js:108 先 getArtifactVersion() → normalizeVersion()（utils.js:38 强制补 v 前缀），
# 之后才拼进 URL —— 所以默认目录必定是 "v44.4.5"，不带 v 的变体在正常流程下不存在。
# 只有显式设了 ELECTRON_CUSTOM_DIR 才会变（此时按 @electron/get 的规则替换 {{ version }}）。
CUSTOM_DIR="${npm_config_electron_custom_dir:-${ELECTRON_CUSTOM_DIR:-}}"
DIR="$(node -e '
  const ver = process.argv[1].replace(/^v/, "");
  const custom = process.argv[2];
  process.stdout.write(custom ? custom.replace(/\{\{\s*version\s*\}\}/g, ver) : "v" + ver);
' "$VER" "$CUSTOM_DIR")"

echo ""
echo "== 对齐结果 =="
align "$DIR"

echo ""
echo "缓存占用: $(du -sh "$CACHE" 2>/dev/null | cut -f1)"
echo ""
echo "提示: node_modules/electron/dist 完整时，install.js 会早退（实测 0.185s exit 0），"
echo "      连缓存都不查 —— 所以只要不删 node_modules，重复 npm install 不会再下载。"
