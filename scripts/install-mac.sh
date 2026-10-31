#!/usr/bin/env bash
# Build PiBar as a release app and install it to /Applications (macOS).
# Usage: npm run app:install
set -euo pipefail
cd "$(dirname "$0")/.."

echo "› Installing / updating dependencies …"
npm install --no-audit --no-fund

echo "› Building release app (first time takes a few minutes) …"
npm run tauri build -- --bundles app

APP="$(find src-tauri/target/release/bundle/macos -maxdepth 1 -name '*.app' | head -n 1)"
if [ -z "$APP" ]; then
  echo "No .app found in src-tauri/target/release/bundle/macos" >&2
  exit 1
fi
NAME="$(basename "$APP")"

echo "› Quitting a running PiBar …"
osascript -e "quit app \"${NAME%.app}\"" >/dev/null 2>&1 || true
sleep 1

echo "› Installing to /Applications/$NAME …"
rm -rf "/Applications/$NAME"
cp -R "$APP" /Applications/

echo "› Starting PiBar"
open "/Applications/$NAME"
echo "Done. macOS asks once more for microphone, screen recording and input monitoring – now for PiBar itself."
