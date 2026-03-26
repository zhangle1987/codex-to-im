#!/usr/bin/env bash
set -euo pipefail

# Install the optional codex-to-im skill for Codex.
# Usage: bash scripts/install-codex.sh [--link]
#   --link  Create a symlink instead of copying (for development)

INTEGRATION_NAME="codex-to-im"
CODEX_SKILLS_DIR="$HOME/.codex/skills"
TARGET_DIR="$CODEX_SKILLS_DIR/$INTEGRATION_NAME"
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Installing optional $INTEGRATION_NAME skill for Codex..."

if [ ! -f "$SOURCE_DIR/SKILL.md" ]; then
  echo "Error: SKILL.md not found in $SOURCE_DIR"
  exit 1
fi

mkdir -p "$CODEX_SKILLS_DIR"

if [ -e "$TARGET_DIR" ]; then
  if [ -L "$TARGET_DIR" ]; then
    EXISTING=$(readlink "$TARGET_DIR")
    echo "Already installed as symlink -> $EXISTING"
  else
    echo "Already installed at $TARGET_DIR"
  fi
  exit 0
fi

if [ "${1:-}" = "--link" ]; then
  ln -s "$SOURCE_DIR" "$TARGET_DIR"
  echo "Symlinked: $TARGET_DIR -> $SOURCE_DIR"
  echo ""
  echo "Development mode: no install/build/prune steps were run against the source repo."
  exit 0
fi

cp -R "$SOURCE_DIR" "$TARGET_DIR"
echo "Copied to: $TARGET_DIR"

if [ ! -d "$TARGET_DIR/node_modules" ] || [ ! -d "$TARGET_DIR/node_modules/@openai/codex-sdk" ]; then
  echo "Installing dependencies..."
  (cd "$TARGET_DIR" && npm install)
fi

if [ ! -f "$TARGET_DIR/dist/daemon.mjs" ]; then
  echo "Building daemon bundle..."
  (cd "$TARGET_DIR" && npm run build)
fi

echo "Pruning dev dependencies..."
(cd "$TARGET_DIR" && npm prune --production)

echo ""
echo "Done. Start a new Codex session and use the installed codex-to-im skill when you need to send artifacts back to IM."
