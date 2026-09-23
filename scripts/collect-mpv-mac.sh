#!/usr/bin/env bash
#
# QYP3-064: 收集 macOS 版 mpv 及其非系统 dylib 闭包到 build/mpv-mac/，
# 供 electron-builder 经 extraResources 打进 .app（resources/mpv/mpv）。
#
# 做法：
#   1. 定位 mpv（MPV_BIN 环境变量 > PATH > Homebrew 常规位置）
#   2. BFS 展开 otool -L 的非系统 dylib（/usr/lib/*、/System/* 为系统库，不收）
#   3. 全部平铺进 build/mpv-mac/lib/，install_name_tool 把引用改写为
#      @executable_path/lib/<name>（主程序）与 @loader_path/<name>（dylib 之间）
#   4. ad-hoc 重签名（install_name_tool 之后 macOS 强制要求，arm64 尤其）
#   5. Darwin 上现场冒烟：build/mpv-mac/mpv --version 必须能跑
#
# 兜底定义：
#   QY_SKIP_MPV_BUNDLE=1 时跳过收集，产出只含 README 的空目录——
#   安装包不带 mpv，运行时 binary-locator 回退到 PATH 查找（用户自装）。
#   其余失败路径（找不到 mpv、otool 缺失、冒烟失败）一律非零退出。
#
# 用法：scripts/collect-mpv-mac.sh [输出目录]   （默认 build/mpv-mac）

set -euo pipefail

STAGING="${1:-build/mpv-mac}"

log() { echo "[collect-mpv-mac] $*"; }
# warn 必须走 stderr：collectable_deps 的 stdout 就是依赖清单，被调用方按行读进
# `while read -r dep`，往 stdout 打日志会被当成一条依赖路径（cp 到不存在的文件）
warn() { echo "[collect-mpv-mac] 警告：$*" >&2; }
die() { echo "[collect-mpv-mac] 失败：$*" >&2; exit 1; }

if [ "${QY_SKIP_MPV_BUNDLE:-0}" = "1" ]; then
  rm -rf "$STAGING"
  mkdir -p "$STAGING"
  printf 'mpv 未随包分发（QY_SKIP_MPV_BUNDLE=1）：应用启动时按 PATH 查找 mpv，请自行安装（brew install mpv）。\n' > "$STAGING/README.txt"
  log "QY_SKIP_MPV_BUNDLE=1，跳过 mpv 收集（运行时走 PATH 兜底）"
  exit 0
fi

command -v otool >/dev/null 2>&1 || die "otool 不可用（需要 Xcode Command Line Tools）"
command -v install_name_tool >/dev/null 2>&1 || die "install_name_tool 不可用"
command -v codesign >/dev/null 2>&1 || die "codesign 不可用"

# ---- 1. 定位 mpv ----------------------------------------------------------
MPV_BIN="${MPV_BIN:-}"
if [ -z "$MPV_BIN" ]; then
  for candidate in "$(command -v mpv || true)" /opt/homebrew/bin/mpv /usr/local/bin/mpv; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      MPV_BIN="$candidate"
      break
    fi
  done
fi
[ -n "$MPV_BIN" ] || die "找不到 mpv。请 brew install mpv、设置 MPV_BIN=…，或用 QY_SKIP_MPV_BUNDLE=1 跳过内置"
MPV_BIN="$(realpath "$MPV_BIN")"
log "mpv 来源：$MPV_BIN"

# ---- 2. BFS 展开 dylib 闭包 ------------------------------------------------
# 已收集的真实路径（去重）。**故意用普通数组 + 线性查找**，不用 `declare -A`：
# macOS 自带的是 bash 3.2（`/bin/bash`），关联数组是 bash 4+ 才有的，
# CI 里 `bash scripts/collect-mpv-mac.sh` 会直接报 `declare: -A: invalid option`
# 并以退出码 2 挂掉（1.5.0 三端 CI 实测，两个 mac job 都死在这）。闭包只有
# 几十个 dylib，线性查找的开销可以忽略。
COLLECTED=()

collected() {
  local x
  for x in ${COLLECTED[@]+"${COLLECTED[@]}"}; do
    [ "$x" = "$1" ] && return 0
  done
  return 1
}

is_system_path() {
  case "$1" in
    /usr/lib/*|/System/*) return 0 ;;
    *) return 1 ;;
  esac
}

# 解析一条依赖为真实文件；解析失败输出空串。$1=依赖原文 $2=引用方文件
resolve_dep() {
  local dep="$1" referrer="$2"
  if is_system_path "$dep"; then
    echo ""
    return
  fi
  case "$dep" in
    @loader_path/*)
      local candidate
      candidate="$(dirname "$referrer")/${dep#@loader_path/}"
      if [ -f "$candidate" ]; then realpath "$candidate"; else echo ""; fi
      ;;
    @executable_path/*)
      # 主程序包外的二进制几乎不用这个前缀；按引用方目录兜底
      local candidate
      candidate="$(dirname "$referrer")/${dep#@executable_path/}"
      if [ -f "$candidate" ]; then realpath "$candidate"; else echo ""; fi
      ;;
    @rpath/*)
      # 按 LC_RPATH 列表逐个试。otool -l 里一条 rpath 是三行
      # （`cmd LC_RPATH` / `cmdsize N` / `path <dir> (offset …)`），
      # 所以要靠 `path ` 前缀定位，别用 `getline` 数行——那样读到的是 cmdsize，
      # 解析出来是 "24" 这种数字，所有 @rpath 依赖都会"解析失败"
      local rpath candidate
      while IFS= read -r rpath; do
        candidate="${rpath}/${dep#@rpath/}"
        if [ -f "$candidate" ]; then realpath "$candidate" && return; fi
      done < <(otool -l "$referrer" | awk '/cmd LC_RPATH/{want=1; next} want && /^[ \t]*path /{print $2; want=0}')
      echo ""
      ;;
    *)
      if [ -f "$dep" ]; then realpath "$dep"; else echo ""; fi
      ;;
  esac
}

# 列出某文件的"可收集"依赖真实路径（系统库与解析失败的除外）
collectable_deps() {
  local file="$1" dep resolved
  while IFS= read -r dep; do
    dep="$(echo "$dep" | awk '{print $1}')"
    resolved="$(resolve_dep "$dep" "$file")"
    if [ -n "$resolved" ]; then
      echo "$resolved"
    elif ! is_system_path "$dep"; then
      warn "$file 依赖 $dep 无法解析，跳过（若运行期需要会由冒烟测试暴露）"
    fi
  done < <(otool -L "$file" | tail -n +2 | cut -d'(' -f1)
}

mkdir -p "$STAGING/lib"
rm -rf "$STAGING/mpv" "$STAGING/lib"/*
cp "$MPV_BIN" "$STAGING/mpv"

QUEUE=("$MPV_BIN")
COLLECTED=("$MPV_BIN")
while [ ${#QUEUE[@]} -gt 0 ]; do
  current="${QUEUE[0]}"
  QUEUE=("${QUEUE[@]:1}")
  while IFS= read -r dep; do
    [ -n "$dep" ] || continue
    if ! collected "$dep"; then
      COLLECTED+=("$dep")
      base="$(basename "$dep")"
      log "收集 $(basename "$dep")"
      cp "$dep" "$STAGING/lib/$base"
      QUEUE+=("$dep")
    fi
  done < <(collectable_deps "$current")
done
log "共收集 ${#COLLECTED[@]} 个文件（含主程序）"

# ---- 3. 改写引用路径 -------------------------------------------------------
# 主程序（位于 $STAGING 根）：依赖 → @executable_path/lib/<name>
deps_of() { otool -L "$1" | tail -n +2 | cut -d'(' -f1 | awk '{print $1}'; }

# 把 $1 的非系统依赖引用改写到 $2（@executable_path/lib 或 @loader_path）。
# **必须先经 resolve_dep 解析再查收集表**：表里存的是依赖的**真实路径**，而
# otool 给出的可能是 `@rpath/libavcodec.dylib` 这类间接引用，拿原文去比对永远
# 不命中——那样收进来的 dylib 会躺在包里没人引用，运行期照旧找不到
rewrite_refs() {
  local file="$1" prefix="$2" dep resolved
  while IFS= read -r dep; do
    [ -n "$dep" ] || continue
    resolved="$(resolve_dep "$dep" "$file")"
    [ -n "$resolved" ] || continue
    collected "$resolved" || continue
    [ "$resolved" != "$MPV_BIN" ] || continue
    install_name_tool -change "$dep" "$prefix/$(basename "$resolved")" "$file"
  done < <(deps_of "$file")
}

rewrite_refs "$STAGING/mpv" "@executable_path/lib"

# 每个 dylib：自身 id → @loader_path/<name>；对其它 dylib 的引用 → @loader_path/<name>
for dylib in "$STAGING"/lib/*; do
  install_name_tool -id "@loader_path/$(basename "$dylib")" "$dylib"
  rewrite_refs "$dylib" "@loader_path"
done

# ---- 4. ad-hoc 重签名 ------------------------------------------------------
for dylib in "$STAGING"/lib/*; do
  codesign -f -s - "$dylib" >/dev/null 2>&1 || die "dylib 签名失败：$dylib"
done
codesign -f -s - "$STAGING/mpv" >/dev/null 2>&1 || die "主程序签名失败"

# ---- 5. 冒烟测试（仅 Darwin 可执行） --------------------------------------
if [ "$(uname)" = "Darwin" ]; then
  if ! "$STAGING/mpv" --version 2>/dev/null | grep -q '^mpv'; then
    die "冒烟测试失败：$STAGING/mpv --version 无法运行（dylib 闭包不完整？）"
  fi
  log "冒烟测试通过：$("$STAGING/mpv" --version | head -n 1)"
else
  log "非 Darwin 主机，跳过冒烟测试（改在 macOS CI 上验证）"
fi

log "完成：$STAGING/mpv + $(ls "$STAGING/lib" | wc -l | tr -d ' ') 个 dylib"
