#!/usr/bin/env bash
# tools/drift.sh —— sync.sh 与 restore.sh 共用的「线上 vs 仓库」内容级差异
#
# 用法：source 之后调用
#   DRIFT_EXCLUDES=("AUDIT.md")            # 可选：按文件名额外排除
#   drift_lines "$SITE_ROOT" "$REPO_ROOT" "${PATHS[@]}"
# 输出：每行一处差异（可直接给人看）；无输出 = 一致。
#
# 三个细节：
#   - 排除 node_modules / vendor（依赖与构建产物本来就不入库）；
#   - 忽略「只有一边存在」但其实是**空目录**的行 —— git 存不了空目录，
#     刚 clone 出来的仓库不会有 agent/docs/ 这类空壳，不该被当成漂移；
#   - 路径清单里 @never 的文件（内部审计记录等）两边都不该出现，由调用方通过
#     DRIFT_EXCLUDES 传进来，避免仓库里没有它而被误报成漂移。
drift_lines() {
  local site="$1" repo="$2"; shift 2
  local raw; raw="$(mktemp)"
  local p line d base name
  local ex=(-x node_modules -x vendor -x .git)
  if [ "${DRIFT_EXCLUDES[@]+set}" = set ]; then
    local e
    for e in "${DRIFT_EXCLUDES[@]}"; do ex+=(-x "$e"); done
  fi
  for p in "$@"; do
    if [ ! -d "$repo/$p" ]; then
      printf '只在站点存在：%s/\n' "$p"
      continue
    fi
    diff -rq "${ex[@]}" "$site/$p" "$repo/$p" >> "$raw" 2>&1 || true
  done
  while IFS= read -r line; do
    case "$line" in
      "Only in "*": "*)
        d="${line#Only in }"; base="${d%%: *}"; name="${d##*: }"
        if [ -d "$base/$name" ] && [ -z "$(ls -A "$base/$name" 2>/dev/null)" ]; then
          continue
        fi
        ;;
    esac
    printf '%s\n' "$line"
  done < "$raw"
  rm -f "$raw"
}
