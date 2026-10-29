#!/bin/bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 || -z "$1" || "$1" == "-" ]]; then
    echo "Usage: $0 'Developer ID Application: Name (TEAMID)' [new-output-directory]" >&2
    exit 2
fi

IDENTITY="$1"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ $# -eq 2 ]]; then
    # Refuse existing output rather than deleting a possibly registered app.
    mkdir "$2"
    OUTPUT_DIR="$(cd "$2" && pwd)"
else
    OUTPUT_DIR="$(mktemp -d /tmp/simplemd-qlspike.XXXXXX)"
fi
SDK="$(xcrun --sdk macosx --show-sdk-path)"
APP="$OUTPUT_DIR/SimpleMDQLSpike.app"
EXTENSION="$APP/Contents/PlugIns/SimpleMDQLPreview.appex"
mkdir -p "$APP/Contents/MacOS" "$EXTENSION/Contents/MacOS" "$OUTPUT_DIR/module-cache"
cp "$SOURCE_DIR/Host-Info.plist" "$APP/Contents/Info.plist"
cp "$SOURCE_DIR/Preview-Info.plist" "$EXTENSION/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" "$EXTENSION/Contents/Info.plist" \
    "$SOURCE_DIR/host.entitlements" "$SOURCE_DIR/preview.entitlements"

for ARCH in arm64 x86_64; do
    xcrun swiftc -sdk "$SDK" -target "$ARCH-apple-macos13.0" \
        -module-cache-path "$OUTPUT_DIR/module-cache" -parse-as-library \
        -framework Cocoa "$SOURCE_DIR/Host.swift" -o "$OUTPUT_DIR/Host-$ARCH"
    xcrun swiftc -sdk "$SDK" -target "$ARCH-apple-macos13.0" \
        -module-cache-path "$OUTPUT_DIR/module-cache" -parse-as-library \
        -application-extension -module-name SimpleMDQLPreview \
        -framework Cocoa -framework QuickLookUI -framework WebKit \
        -Xlinker -e -Xlinker _NSExtensionMain \
        "$SOURCE_DIR/PreviewController.swift" -o "$OUTPUT_DIR/Preview-$ARCH"
done
xcrun lipo -create "$OUTPUT_DIR/Host-arm64" "$OUTPUT_DIR/Host-x86_64" \
    -output "$APP/Contents/MacOS/SimpleMDQLHost"
xcrun lipo -create "$OUTPUT_DIR/Preview-arm64" "$OUTPUT_DIR/Preview-x86_64" \
    -output "$EXTENSION/Contents/MacOS/SimpleMDQLPreview"

# Sign inner code first. Never replace these entitlements with Electron's.
codesign --force --sign "$IDENTITY" --options runtime --timestamp \
    --entitlements "$SOURCE_DIR/preview.entitlements" "$EXTENSION"
codesign --force --sign "$IDENTITY" --options runtime --timestamp \
    --entitlements "$SOURCE_DIR/host.entitlements" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
echo "Built and signed: $APP"
