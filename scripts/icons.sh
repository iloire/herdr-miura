#!/usr/bin/env bash
# Draws every app icon from src-tauri/icons/icon.svg. Edge and dev are the same
# mark on a violet and a red tile, so the Dock tells the channels apart.
# Needs rsvg-convert (brew install librsvg) and macOS's iconutil.
set -euo pipefail
cd "$(dirname "$0")/.."

icons=src-tauri/icons
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

icns() { # icns <tile color> <output>
  sed "s/#0b0e12/$1/" "$icons/icon.svg" >"$tmp/icon.svg"
  mkdir "$tmp/icon.iconset"
  for size in 16 32 128 256 512; do
    rsvg-convert -w "$size" "$tmp/icon.svg" -o "$tmp/icon.iconset/icon_${size}x${size}.png"
    rsvg-convert -w "$((size * 2))" "$tmp/icon.svg" -o "$tmp/icon.iconset/icon_${size}x${size}@2x.png"
  done
  iconutil -c icns "$tmp/icon.iconset" -o "$2"
  rm -r "$tmp/icon.iconset"
}

rsvg-convert -w 1024 "$icons/icon.svg" -o "$tmp/source.png"
npx tauri icon "$tmp/source.png" -o "$tmp/out" >/dev/null
rm "$tmp/out/64x64.png"
cp "$tmp"/out/*.png "$tmp"/out/*.ico "$icons/"

icns '#0b0e12' "$icons/icon.icns"
icns '#6e56cf' "$icons/edge/icon.icns"
icns '#e5484d' "$icons/dev/icon.icns"
