#!/usr/bin/env bash
# macOS/Linux twin of deploy.ps1: the Sprite clones this public repo at your
# current branch (only pushed commits deploy), then runs the setup script.
#   ./scripts/deploy.sh [sprite] [agent-id] [branch]
set -euo pipefail
SPRITE="${1:-banquet-captain}"
AGENT_ID="${2:-$SPRITE}"
cd "$(dirname "$0")/.."
REF="${3:-$(git rev-parse --abbrev-ref HEAD)}"
REPO="${CAPTAIN_REPO:-https://github.com/flasun/banquet-captain}"
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "Unexpected branch name: $REF" >&2; exit 1; }

REMOTE_HOME="$(sprite exec -s "$SPRITE" -- bash -lc 'echo $HOME' | tail -n 1 | tr -d '\r\n')"
[[ "$REMOTE_HOME" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "Could not read HOME on $SPRITE" >&2; exit 1; }
DEST="$REMOTE_HOME/banquet-captain"

echo "== $SPRITE checks out $REF into $DEST"
sprite exec -s "$SPRITE" -- bash -lc "set -e; command -v git >/dev/null || { echo 'git is not installed on the Sprite' >&2; exit 1; }; \
if [ -d '$DEST/.git' ]; then git -C '$DEST' fetch -q --depth 1 origin '$REF'; git -C '$DEST' checkout -q --force FETCH_HEAD; \
else git clone -q --depth 1 --branch '$REF' '$REPO' '$DEST'; fi; git -C '$DEST' log -1 --oneline"

echo "== setup on $SPRITE"
sprite exec -s "$SPRITE" -- bash -lc "chmod +x '$DEST/scripts/sprite-setup.sh' && '$DEST/scripts/sprite-setup.sh' '$AGENT_ID'"
