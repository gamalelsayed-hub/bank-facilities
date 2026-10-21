#!/usr/bin/env bash
# يبني نسخة ويندوز محمولة: dist/BankFacilities-Windows.zip
# يتطلب: bash, curl, unzip, zip  (يعمل على Linux أو macOS أو Git Bash على ويندوز)
set -euo pipefail
ELECTRON_VERSION="31.7.7"
ROOT="$(cd "$(dirname "$0")" && pwd)"
WORK="$ROOT/dist/BankFacilities"
ZIP="$ROOT/dist/electron-v$ELECTRON_VERSION-win32-x64.zip"
mkdir -p "$ROOT/dist"
if [ ! -f "$ZIP" ]; then
  curl -fL -o "$ZIP" "https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-win32-x64.zip"
fi
rm -rf "$WORK" && mkdir -p "$WORK"
unzip -q "$ZIP" -d "$WORK"
mv "$WORK/electron.exe" "$WORK/BankFacilities.exe"
rm -f "$WORK/resources/default_app.asar"
mkdir -p "$WORK/resources/app"
cp "$ROOT"/app/{package.json,main.js,preload.js,index.html,template.xlsx,icon.png} "$WORK/resources/app/"
cp "$ROOT/app/README-AR.txt" "$WORK/اقرأني.txt"
(cd "$ROOT/dist" && rm -f BankFacilities-Windows.zip && zip -qr BankFacilities-Windows.zip BankFacilities)
echo "تم: $ROOT/dist/BankFacilities-Windows.zip"
