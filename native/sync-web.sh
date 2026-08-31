#!/usr/bin/env bash
# Copy the web app into the shell's bundle.
#
# ONE source of truth: the repository root IS the app, deployed to GitHub Pages
# and wrapped here. Nothing is edited in www/ — it is a copy, rebuilt on demand —
# so a fix made in the field on the web version is in the next native build
# with no porting and no drift.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/.."
dst="$here/www"

[ -d "$src" ] || { echo "web app not found at $src" >&2; exit 1; }

rm -rf "$dst"
mkdir -p "$dst"

# The app itself. tools/ is a desktop test harness and never ships.
for f in index.html app.js geo.js native.js style.css manifest.webmanifest; do
  cp "$src/$f" "$dst/$f"
done
cp -R "$src/icons" "$dst/icons"

# The service worker is deliberately NOT copied: in the shell the bundle IS
# local, so a cache layer in front of it can only serve yesterday's build.
# index.html registers it defensively, which fails harmlessly without the file.

echo "synced $(ls "$dst" | wc -l | tr -d ' ') entries -> www/"
