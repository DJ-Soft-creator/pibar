#!/usr/bin/env bash
# Build PiBar as a release app and install it to /Applications (macOS).
# Usage: npm run app:install
#
# Optional: PIBAR_SIGN=1 npm run app:install
#
# macOS keeps permissions (Input Monitoring, Microphone, Screen Recording, Local Network) per code signature. A plain
# build is signed "ad hoc" with a new signature every time, so a permission granted earlier silently stops working
# after a rebuild (the switch in System Settings stays on, but no longer applies).
#   Default: the app stays ad-hoc signed and the old permissions are reset, so macOS asks again. The keychain is not
#            touched.
#   PIBAR_SIGN=1: the app is signed with a local certificate that stays the same ("PiBar Local Signing", created once
#            in the login keychain), so permissions survive rebuilds. macOS may ask for the keychain password.
# This script reads, copies and sends no personal data.
set -euo pipefail
cd "$(dirname "$0")/.."

IDENT="PiBar Local Signing"
BUNDLE_ID="app.pibar.desktop"
KC="$HOME/Library/Keychains/login.keychain-db"

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

# ---------- stable signature (only with PIBAR_SIGN=1) ----------
stable=0
if [ "${PIBAR_SIGN:-0}" = 1 ]; then
  if ! security find-certificate -c "$IDENT" "$KC" >/dev/null 2>&1; then
    echo "› Creating a local signing certificate \"$IDENT\" (once) …"
    tmp="$(mktemp -d)"
    cat >"$tmp/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $IDENT
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CNF
    # /usr/bin/openssl (LibreSSL) writes a PKCS#12 file that the keychain can import
    /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$tmp/cert.cnf" \
      -keyout "$tmp/key.pem" -out "$tmp/cert.pem" >/dev/null 2>&1
    /usr/bin/openssl pkcs12 -export -name "$IDENT" -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
      -out "$tmp/id.p12" -passout pass:pibar
    security import "$tmp/id.p12" -k "$KC" -P pibar -T /usr/bin/codesign >/dev/null ||
      echo "  (import into the keychain failed)"
    echo "  macOS may now ask for your password to trust the certificate for code signing."
    security add-trusted-cert -r trustRoot -p codeSign -k "$KC" "$tmp/cert.pem" ||
      echo "  (not trusted – signing is tried anyway)"
    rm -rf "$tmp"
  fi

  echo "› Signing with \"$IDENT\" …"
  if codesign --force --deep --sign "$IDENT" "$APP" 2>/dev/null; then
    stable=1
  else
    echo "  Signing failed – the app stays ad-hoc signed; permissions are reset so macOS asks again."
  fi
fi

# ---------- install ----------
echo "› Quitting a running PiBar …"
osascript -e "quit app \"${NAME%.app}\"" >/dev/null 2>&1 || true
# a PiBar from the development mode holds the same keyboard shortcut
pkill -f "target/debug/pibar" >/dev/null 2>&1 && echo "  (stopped PiBar from the development mode)" || true
sleep 1

# was the installed version already signed with the stable certificate?
prev_stable=0
codesign -dv "/Applications/$NAME" 2>&1 | grep -q "Authority=$IDENT" && prev_stable=1

echo "› Installing to /Applications/$NAME …"
rm -rf "/Applications/$NAME"
cp -R "$APP" /Applications/

# permissions granted to an older signature no longer apply: reset them, so macOS asks again
if [ "$stable" = 0 ] || [ "$prev_stable" = 0 ]; then
  echo "› Resetting old permissions (macOS asks again) …"
  for svc in ListenEvent Microphone ScreenCapture; do
    tccutil reset "$svc" "$BUNDLE_ID" >/dev/null 2>&1 || true
  done
fi

echo "› Starting PiBar"
open "/Applications/$NAME"
if [ "$stable" = 1 ]; then
  echo "Done. Permissions now survive rebuilds."
else
  echo "Done. macOS asks again for input monitoring, microphone and screen recording."
  echo "(To keep permissions across rebuilds: PIBAR_SIGN=1 npm run app:install – see README.)"
fi
echo "If the double tap does not react: System Settings → Privacy & Security → Input Monitoring → remove PiBar (−),"
echo "add it again (+, /Applications/$NAME), restart PiBar."
