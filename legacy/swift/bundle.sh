#!/bin/sh
# Builds CCUsage in release mode and wraps it in a minimal .app bundle.
# Usage: scripts/bundle.sh [output-dir]
set -eu

cd "$(dirname "$0")/.."

if [ -d /Volumes/external_disk/.cache ]; then
    cache_root=/Volumes/external_disk/.cache/CCUsage
else
    cache_root="$HOME/Library/Caches/CCUsage"
fi
scratch="$cache_root/build"
out_dir="${1:-$cache_root}"
app="$out_dir/CCUsage.app"

swift build -c release --scratch-path "$scratch"
bin_dir=$(swift build -c release --scratch-path "$scratch" --show-bin-path)

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$bin_dir/CCUsage" "$app/Contents/MacOS/CCUsage"

cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>CCUsage</string>
    <key>CFBundleIdentifier</key><string>local.ccusage</string>
    <key>CFBundleName</key><string>CC 用量</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

codesign --force --sign - "$app" >/dev/null
echo "$app"
