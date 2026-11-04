#!/usr/bin/env bash
set -euo pipefail

# Physical path: a checkout reached through a symlink must record the same targets as the real path.
REPO_DIR="$(cd "$(dirname "$0")" && pwd -P)"
CC_SKILLS_DIR="$REPO_DIR/claude/skills"
CC_AGENTS_DIR="$REPO_DIR/claude/agents"
# Older versions of this script linked the pi originals; those links are ours to migrate, never to keep.
LEGACY_SKILLS_DIR="$REPO_DIR/skills"
TARGET_DIR="$HOME/.claude"
UNINSTALL=false

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Link the Claude Code variants of this repo's skills and agents into a Claude directory:
  claude/skills/<name>  -> <dir>/skills/<name>
  claude/agents/<name>.md -> <dir>/agents/<name>.md
The pi originals under skills/ are never linked. A link left by an older version of this
script (pointing at skills/<name>) is replaced by the Claude Code variant.

Options:
  -d, --dir <path>   Target Claude directory (default: ~/.claude)
  -u, --uninstall    Remove this repo's symlinks (variants and legacy pi links)
  -h, --help         Show this help

EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--dir)
      TARGET_DIR="${2:?--dir requires a path}"
      shift 2
      ;;
    -u|--uninstall)
      UNINSTALL=true
      shift
      ;;
    -h|--help)
      usage; exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# points_to <link> <source>: the link resolves to <source>. Compares resolved paths so links written by an older
# version through a symlinked checkout (logical path) still count as ours.
points_to() {
  [[ -L "$1" ]] || return 1
  local cur; cur="$(readlink -f "$1")" || return 1
  [[ -n "$cur" && "$cur" == "$(readlink -f "$2")" ]]
}

# install_link <source> <link> [legacy-source]
install_link() {
  local src="$1" link="$2" legacy="${3:-}"
  if points_to "$link" "$src"; then
    echo "exists    $link"
  elif [[ -n "$legacy" ]] && points_to "$link" "$legacy"; then
    ln -sfn "$src" "$link"
    echo "migrated  $link -> $src  (was the pi original)"
  elif [[ -L "$link" && ! -e "$link" ]]; then
    echo "conflict  $link  (dangling symlink to $(readlink "$link") — skipping; if it is from a moved checkout, rm '$link' and re-run)"
  elif [[ -e "$link" || -L "$link" ]]; then
    echo "conflict  $link  (exists but points elsewhere — skipping)"
  else
    ln -s "$src" "$link"
    echo "linked    $link -> $src"
  fi
}

# uninstall_link <link> <source>...
uninstall_link() {
  local link="$1"; shift
  if [[ -L "$link" ]]; then
    for src in "$@"; do
      if points_to "$link" "$src"; then
        rm "$link"
        echo "removed   $link"
        return
      fi
    done
    if [[ ! -e "$link" ]]; then
      # A dangling link cannot be proven ours (its checkout may be moved or just unmounted): leave it, say how to remove it.
      echo "skipped   $link  (dangling symlink to $(readlink "$link"); if it is from a moved checkout, rm '$link')"
    else
      echo "skipped   $link  (symlink to another location, not this repo)"
    fi
  elif [[ -e "$link" ]]; then
    echo "skipped   $link  (exists but is not a symlink to this repo)"
  else
    echo "skipped   $link  (not found)"
  fi
}

SKILLS_TARGET="$TARGET_DIR/skills"
AGENTS_TARGET="$TARGET_DIR/agents"
if [[ "$UNINSTALL" == false ]]; then
  mkdir -p "$SKILLS_TARGET" "$AGENTS_TARGET"
fi

for skill_path in "$CC_SKILLS_DIR"/*/; do
  skill_path="${skill_path%/}"
  name="$(basename "$skill_path")"
  if [[ "$UNINSTALL" == true ]]; then
    uninstall_link "$SKILLS_TARGET/$name" "$skill_path" "$LEGACY_SKILLS_DIR/$name"
  else
    install_link "$skill_path" "$SKILLS_TARGET/$name" "$LEGACY_SKILLS_DIR/$name"
  fi
done

for agent_path in "$CC_AGENTS_DIR"/*.md; do
  name="$(basename "$agent_path")"
  if [[ "$UNINSTALL" == true ]]; then
    uninstall_link "$AGENTS_TARGET/$name" "$agent_path"
  else
    install_link "$agent_path" "$AGENTS_TARGET/$name"
  fi
done
