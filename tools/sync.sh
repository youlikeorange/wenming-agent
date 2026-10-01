#!/usr/bin/env bash
# tools/sync.sh —— 把宿主站点里 agent 子项目的当前代码同步进本仓库，并提交/推送
#
# 用法（在本仓库根目录执行）：
#   ./tools/sync.sh                    同步 → 显示改动 → 提交 → 推送
#   ./tools/sync.sh -m "说明"           自定义提交说明
#   ./tools/sync.sh --check            只检查「线上 vs 仓库」的差异，不写任何文件（有差异退出码 1）
#   ./tools/sync.sh -s /path/to/site   指定宿主站点根目录
#
# 站点根目录按这个顺序取：-s 参数 > 环境变量 SITE_ROOT > tools/site.conf（本机配置，不入库）。
#
# 同步哪些路径由 tools/paths.conf 决定：
#   子项目本体（agent / lib/agent / public/llm-chat）整目录同步；
#   宿主依赖（lib/*.js、server.js）只做留档，也放在真实相对路径上；
#   @never 的文件（内部审计记录）两边都不碰。
# node_modules 不入库；构建产物（public/llm-chat/vendor）**入库**——它让仓库下载即可运行，
# 见 README「快速开始」。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROXY="${PROXY:-http://127.0.0.1:7890}"
BRANCH="${BRANCH:-main}"
MSG=""; CHECK=0

while [ $# -gt 0 ]; do
  case "$1" in
    -m|--message) MSG="$2"; shift 2 ;;
    --check)      CHECK=1; shift ;;
    -s|--site)    SITE_ROOT="$2"; shift 2 ;;
    -h|--help)    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $1（-h 查看用法）" >&2; exit 2 ;;
  esac
done

SITE_CONF="$REPO_ROOT/tools/site.conf"
[ -f "$SITE_CONF" ] && . "$SITE_CONF"   # 里面的写法是 : "${SITE_ROOT:=...}"，不会盖掉 -s/环境变量
[ -n "${SITE_ROOT:-}" ] || {
  echo "❌ 没给站点根目录。三选一：用 -s /path/to/site、设环境变量 SITE_ROOT、或在 tools/site.conf 里写一行 SITE_ROOT=..." >&2
  exit 1
}
[ -d "$SITE_ROOT" ] || { echo "❌ 站点目录不存在：$SITE_ROOT" >&2; exit 1; }

# ── 读路径清单 ──────────────────────────────────────────────
PATHS=(); SYNC_ONLY=(); NEVER=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"
  line="$(printf '%s' "$line" | xargs)"
  [ -n "$line" ] || continue
  case "$line" in
    *"@sync-only "*) SYNC_ONLY+=("${line#*@sync-only }") ;;
    *"@never "*)     NEVER+=("${line#*@never }") ;;
    *)               PATHS+=("$line") ;;
  esac
done < "$REPO_ROOT/tools/paths.conf"
[ "${#PATHS[@]}" -gt 0 ] || { echo "❌ tools/paths.conf 里没有可同步的路径" >&2; exit 1; }

DIFF_TMP="$(mktemp)"; trap 'rm -f "$DIFF_TMP"' EXIT
# shellcheck source=tools/drift.sh
source "$REPO_ROOT/tools/drift.sh"

# 内容级对比：子项目本体 + 宿主依赖留档（@never 的文件不算漂移）
count_drift() {
  local f
  DRIFT_EXCLUDES=()
  for f in "${NEVER[@]}"; do DRIFT_EXCLUDES+=("$(basename "$f")"); done
  drift_lines "$SITE_ROOT" "$REPO_ROOT" "${PATHS[@]}" > "$DIFF_TMP"
  for f in "${SYNC_ONLY[@]}"; do
    if   [ ! -f "$SITE_ROOT/$f" ]; then printf '站点里没有：%s\n' "$f" >> "$DIFF_TMP"
    elif [ ! -f "$REPO_ROOT/$f" ]; then printf '仓库里没有：%s\n' "$f" >> "$DIFF_TMP"
    elif ! cmp -s "$SITE_ROOT/$f" "$REPO_ROOT/$f"; then printf '文件不同：%s\n' "$f" >> "$DIFF_TMP"
    fi
  done
  wc -l < "$DIFF_TMP" | tr -d ' '
}

# ── 只检查 ─────────────────────────────────────────────────
if [ "$CHECK" = 1 ]; then
  n="$(count_drift)"
  if [ "$n" = 0 ]; then
    echo "✅ 线上与仓库一致（无漂移）"
    exit 0
  fi
  echo "⚠️  线上与仓库有 $n 处差异（下面这些还没同步进仓库）："
  sed 's/^/  /' "$DIFF_TMP"
  exit 1
fi

# ── 同步 ───────────────────────────────────────────────────
for p in "${PATHS[@]}"; do
  if [ ! -d "$SITE_ROOT/$p" ]; then
    echo "  ⚠️ 站点里没有 $p/，跳过"
    continue
  fi
  mkdir -p "$REPO_ROOT/$p"
  # --delete：仓库里多余的文件一并清掉，保证仓库 == 站点当前状态
  # node_modules / .git 与 @never 的文件是排除项，不受 --delete 影响
  # （vendor 不再排除：预构建界面随仓库分发，sync 会一起刷新它）
  ex=(--exclude 'node_modules/' --exclude '.git/')
  for n in "${NEVER[@]}"; do
    case "$n" in "$p"/*) ex+=(--exclude "/${n#"$p"/}") ;; esac
  done
  rsync -a --delete "${ex[@]}" "$SITE_ROOT/$p/" "$REPO_ROOT/$p/"
  echo "  ✔ $p/"
done

for f in "${SYNC_ONLY[@]}"; do
  if [ -f "$SITE_ROOT/$f" ]; then
    mkdir -p "$REPO_ROOT/$(dirname "$f")"
    cp -a "$SITE_ROOT/$f" "$REPO_ROOT/$f"
  else
    echo "  ⚠️ 宿主依赖不存在，跳过：$f"
  fi
done
echo "  ✔ 宿主依赖留档 ${#SYNC_ONLY[@]} 个文件"

# @never 的文件不允许落在仓库里（防止旧副本或手工拷入）
for n in "${NEVER[@]}"; do
  [ -e "$REPO_ROOT/$n" ] && rm -f "$REPO_ROOT/$n" && echo "  ✔ 已移出仓库（不外传）：$n"
done

# ── 提交 ───────────────────────────────────────────────────
cd "$REPO_ROOT"
if [ -z "$(git status --porcelain)" ]; then
  echo "▶ 无变化，不提交（仓库已是最新）"
  exit 0
fi
git add -A
echo "▶ 改动概览："
git diff --cached --stat | tail -n 20 | sed 's/^/  /'

[ -n "$MSG" ] || MSG="sync: 同步站点代码 $(date '+%Y-%m-%d %H:%M')"
git commit -q -m "$MSG"
echo "▶ 已提交：$MSG"

echo "▶ 推送（走代理 $PROXY）…"
GIT_TERMINAL_PROMPT=0 git -c http.proxy="$PROXY" -c https.proxy="$PROXY" \
  push origin "$BRANCH" 2>&1 | tail -3
echo "✅ 同步完成。要留一个可回滚的版本点，再执行："
echo "     git tag vX.Y.Z && git -c http.proxy=$PROXY push origin vX.Y.Z"
