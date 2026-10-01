#!/usr/bin/env bash
# tools/restore.sh —— 回滚：把本仓库（通常是某个 tag）的内容恢复到宿主站点
#
# 用法（在本仓库根目录执行）：
#   ./tools/restore.sh                 恢复到当前 checkout 的版本
#   ./tools/restore.sh v2.0.0          先切到该版本（tag/分支/提交号），再恢复
#   ./tools/restore.sh --with-host-deps 连宿主依赖留档（lib/*.js、server.js）一起写回站点
#   ./tools/restore.sh --dry-run       只说要做什么，不写任何文件
#   ./tools/restore.sh -y              跳过确认
#
# 站点根目录按这个顺序取：-s 参数 > 环境变量 SITE_ROOT > tools/site.conf（本机配置，不入库）。
#
# 恢复流程：备份站点现状 → 用仓库内容覆盖 → 重建界面产物 → 提示重启站点。
# 覆盖前会把站点里将被覆盖的文件打包到 ../wenming-agent-backups/，随时可退回来。
# paths.conf 里 @never 的文件（内部审计记录）两边都不碰：既不写回，也不会被 --delete 删掉。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$(dirname "$REPO_ROOT")/wenming-agent-backups}"
VERSION=""; ASSUME_YES=0; DRY=0; WITH_HOST=0

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes)          ASSUME_YES=1; shift ;;
    --dry-run)         DRY=1; shift ;;
    --with-host-deps)  WITH_HOST=1; shift ;;
    -s|--site)         SITE_ROOT="$2"; shift 2 ;;
    -h|--help)         sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)                echo "未知参数: $1（-h 查看用法）" >&2; exit 2 ;;
    *)                 VERSION="$1"; shift ;;
  esac
done

SITE_CONF="$REPO_ROOT/tools/site.conf"
[ -f "$SITE_CONF" ] && . "$SITE_CONF"
[ -n "${SITE_ROOT:-}" ] || {
  echo "❌ 没给站点根目录。三选一：用 -s /path/to/site、设环境变量 SITE_ROOT、或在 tools/site.conf 里写一行 SITE_ROOT=..." >&2
  exit 1
}
[ -d "$SITE_ROOT" ] || { echo "❌ 站点目录不存在：$SITE_ROOT" >&2; exit 1; }

# ── 读路径清单（与 sync.sh 同一份） ───────────────────────────
PATHS=(); SYNC_ONLY=(); NEVER=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"; line="$(printf '%s' "$line" | xargs)"
  [ -n "$line" ] || continue
  case "$line" in
    *"@sync-only "*) SYNC_ONLY+=("${line#*@sync-only }") ;;
    *"@never "*)     NEVER+=("${line#*@never }") ;;
    *)               PATHS+=("$line") ;;
  esac
done < "$REPO_ROOT/tools/paths.conf"

cd "$REPO_ROOT"

# ── 切版本 ─────────────────────────────────────────────────
if [ -n "$VERSION" ]; then
  git rev-parse --verify --quiet "$VERSION^{commit}" >/dev/null \
    || { echo "❌ 仓库里没有这个版本：$VERSION（git tag -l 看列表）" >&2; exit 1; }
  if [ "$DRY" = 0 ]; then
    git checkout -q "$VERSION"
    echo "▶ 已切到 $VERSION"
  else
    echo "▶ 将切到 $VERSION（--dry-run，未执行）"
  fi
fi

COMMIT="$(git rev-parse --short HEAD)"
SUBJECT="$(git log -1 --format='%s')"
DATE="$(git log -1 --format='%ad' --date=short)"
TAG="$(git describe --tags --exact-match HEAD 2>/dev/null || echo '(未打 tag)')"

echo
echo "  即将恢复的版本：$COMMIT  $DATE  ${TAG}"
echo "  提交说明：$SUBJECT"
echo "  仓库当前状态：$(git status --porcelain | wc -l | tr -d ' ') 处未提交改动（不影响恢复，恢复用的是提交内容）"
echo "  目标站点：$SITE_ROOT"
echo

# ── 线上 vs 仓库 的差异提示（挽救「仓库没同步」的误回滚） ──────
if [ "${#PATHS[@]}" -gt 0 ]; then
  # shellcheck source=tools/drift.sh
  source "$REPO_ROOT/tools/drift.sh"
  DRIFT_EXCLUDES=()
  for f in "${NEVER[@]}"; do DRIFT_EXCLUDES+=("$(basename "$f")"); done
  DRIFT="$(mktemp)"; trap 'rm -f "$DRIFT"' EXIT
  drift_lines "$SITE_ROOT" "$REPO_ROOT" "${PATHS[@]}" > "$DRIFT"
  if [ -s "$DRIFT" ]; then
    echo "  ⚠️ 站点现在和这个版本有 $(wc -l < "$DRIFT" | tr -d ' ') 处不同（下面只列前 10 条）："
    head -10 "$DRIFT" | sed 's/^/     /'
    echo "     ……这些差异会被覆盖掉（备份里都有）。若差异很多，先想想仓库是不是该先 ./tools/sync.sh。"
  else
    echo "  站点当前内容与该版本一致，无需覆盖。"
  fi
  echo
fi

if [ "$DRY" = 1 ]; then
  echo "▶ --dry-run：以下动作不会执行 ——"
  echo "     备份 $SITE_ROOT 的 {$(IFS=,; echo "${PATHS[*]}")} → $BACKUP_DIR"
  echo "     覆盖：${PATHS[*]}"
  [ "$WITH_HOST" = 1 ] && echo "     覆盖宿主依赖：${SYNC_ONLY[*]}"
  echo "     保持不动（@never）：${NEVER[*]}"
  echo "     重建：cd $SITE_ROOT/agent && npm run build"
  exit 0
fi

# ── 确认 ───────────────────────────────────────────────────
if [ "$ASSUME_YES" != 1 ]; then
  printf "  确认恢复？(输入 yes 继续) " >&2
  read -r ans
  [ "$ans" = "yes" ] || { echo "  已取消。"; exit 1; }
fi

# ── 备份站点现状 ───────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
STAMP="$(date '+%Y%m%d-%H%M%S')"
BACKUP="$BACKUP_DIR/restore-$STAMP-before-$COMMIT.tar.gz"
TAR_LIST=()
for p in "${PATHS[@]}"; do [ -e "$SITE_ROOT/$p" ] && TAR_LIST+=("$p"); done
[ "$WITH_HOST" = 1 ] && for h in "${SYNC_ONLY[@]}"; do [ -e "$SITE_ROOT/$h" ] && TAR_LIST+=("$h"); done
if [ "${#TAR_LIST[@]}" -gt 0 ]; then
  # 依赖（node_modules）与构建产物（vendor）不进备份：都能再生成，且体积大
  tar --exclude='agent/node_modules' --exclude='public/llm-chat/vendor' \
      -czf "$BACKUP" -C "$SITE_ROOT" "${TAR_LIST[@]}"
  echo "▶ 已备份站点现状：$BACKUP ($(du -h "$BACKUP" | cut -f1)；不含 node_modules 与构建产物)"
fi

# ── 覆盖 ───────────────────────────────────────────────────
for p in "${PATHS[@]}"; do
  mkdir -p "$SITE_ROOT/$p"
  ex=(--exclude 'node_modules/' --exclude 'vendor/' --exclude '.git/')
  for n in "${NEVER[@]}"; do
    case "$n" in "$p"/*) ex+=(--exclude "/${n#"$p"/}") ;; esac
  done
  rsync -a --delete "${ex[@]}" "$REPO_ROOT/$p/" "$SITE_ROOT/$p/"
  echo "  ✔ 已恢复 $p/"
done
if [ "$WITH_HOST" = 1 ]; then
  for h in "${SYNC_ONLY[@]}"; do
    src="$REPO_ROOT/$h"
    [ -f "$src" ] || { echo "  ⚠️ 仓库里没有 $h，跳过"; continue; }
    mkdir -p "$SITE_ROOT/$(dirname "$h")"
    cp -a "$src" "$SITE_ROOT/$h"
    echo "  ✔ 已恢复（宿主依赖）$h"
  done
fi

# ── 重建界面产物 ───────────────────────────────────────────
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
echo
if [ -d "$SITE_ROOT/agent/node_modules" ] && command -v npm >/dev/null; then
  echo "▶ 重建界面产物（npm run build）…"
  ( cd "$SITE_ROOT/agent" && npm run build 2>&1 | tail -4 | sed 's/^/  /' )
else
  echo "⚠️  没找到 agent/node_modules 或 npm，界面产物未重建。请手动："
  echo "     cd $SITE_ROOT/agent && npm install && npm run build"
fi

echo
echo "✅ 恢复完成（版本 $COMMIT $TAG）。"
echo "   服务端（lib/agent/*）的改动**必须重启站点才生效**："
echo "     cd $SITE_ROOT && ./down.sh && ./up.sh"
echo "   回退这次恢复：tar -xzf $BACKUP -C $SITE_ROOT"
[ -n "$VERSION" ] && echo "   仓库当前在 detached HEAD；回到主线：git checkout main"
