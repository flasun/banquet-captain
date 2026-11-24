#!/usr/bin/env bash
# macOS/Linux twin of deploy.ps1: push the source with `sprite file push`, then set up on the Sprite.
set -euo pipefail
SPRITE="${1:-banquet-captain}"
AGENT_ID="${2:-$SPRITE}"
cd "$(dirname "$0")/.."

REMOTE_HOME="$(sprite exec -s "$SPRITE" -- bash -lc 'echo $HOME' | tr -d '\r\n')"
DEST="$REMOTE_HOME/banquet-captain"
echo "== pushing to $SPRITE:$DEST"
sprite exec -s "$SPRITE" -- bash -lc "mkdir -p '$DEST'"
for f in package.json package-lock.json tsconfig.json README.md; do
  [ -f "$f" ] && sprite file push "$f" "$SPRITE:$DEST/$f"
done
for d in src test scripts; do
  sprite file push -r "$d" "$SPRITE:$DEST/"
done

echo "== setup on $SPRITE"
sprite exec -s "$SPRITE" -- bash -lc "chmod +x '$DEST/scripts/sprite-setup.sh' && '$DEST/scripts/sprite-setup.sh' '$AGENT_ID'"
