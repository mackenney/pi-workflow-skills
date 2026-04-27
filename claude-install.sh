#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_DIR="$REPO_DIR/skills"
TARGET_DIR="$HOME/.claude"
UNINSTALL=false

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Install skills from this repo as symlinks into a Claude skills directory.
Fallback setup for agents that use ~/.claude/ instead of pi's native skill loader.

Options:
  -d, --dir <path>   Target Claude directory (default: ~/.claude)
  -u, --uninstall    Remove symlinks instead of creating them
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

SKILLS_TARGET="$TARGET_DIR/skills"

if [[ "$UNINSTALL" == false ]]; then
  mkdir -p "$SKILLS_TARGET"
fi

skills=("$SKILLS_DIR"/*)

for skill_path in "${skills[@]}"; do
  skill_name="$(basename "$skill_path")"
  link="$SKILLS_TARGET/$skill_name"

  if [[ "$UNINSTALL" == true ]]; then
    if [[ -L "$link" && "$(readlink "$link")" == "$skill_path" ]]; then
      rm "$link"
      echo "removed   $link"
    elif [[ -e "$link" ]]; then
      echo "skipped   $link  (exists but is not a symlink to this repo)"
    else
      echo "skipped   $link  (not found)"
    fi
  else
    if [[ -L "$link" && "$(readlink "$link")" == "$skill_path" ]]; then
      echo "exists    $link"
    elif [[ -e "$link" ]]; then
      echo "conflict  $link  (exists but points elsewhere — skipping)"
    else
      ln -s "$skill_path" "$link"
      echo "linked    $link -> $skill_path"
    fi
  fi
done
