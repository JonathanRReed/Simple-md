#!/bin/bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 3 || -z "$1" || "$1" == "-" ]]; then
    echo "Usage: $0 'Developer ID Application: Name (TEAMID)' [new-output-directory] [view|data|data-static]" >&2
    exit 2
fi

IDENTITY="$1"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
MODE="${3:-view}"
case "$MODE" in
    view) PREVIEW_SOURCE=PreviewController.swift; ENTITLEMENTS=preview.entitlements ;;
    data|data-static) PREVIEW_SOURCE=PreviewProvider.swift; ENTITLEMENTS=data-preview.entitlements ;;
    *) echo "Expected view, data, or data-static" >&2; exit 2 ;;
esac
if [[ $# -ge 2 ]]; then
    # Refuse existing output rather than deleting a possibly registered app.
    mkdir "$2"
    OUTPUT_DIR="$(cd "$2" && pwd)"
else
    OUTPUT_DIR="$(mktemp -d /tmp/simplemd-qlspike.XXXXXX)"
fi
SDK="$(xcrun --sdk macosx --show-sdk-path)"
APP="$OUTPUT_DIR/SimpleMDQLSpike.app"
EXTENSION="$APP/Contents/PlugIns/SimpleMDQLPreview.appex"
THUMBNAIL="$APP/Contents/PlugIns/SimpleMDQLThumbnail.appex"
mkdir -p "$APP/Contents/MacOS" "$EXTENSION/Contents/MacOS" \
    "$THUMBNAIL/Contents/MacOS" "$OUTPUT_DIR/module-cache"
cp "$SOURCE_DIR/Host-Info.plist" "$APP/Contents/Info.plist"
cp "$SOURCE_DIR/Preview-Info.plist" "$EXTENSION/Contents/Info.plist"
cp "$SOURCE_DIR/thumbnail/Info.plist" "$THUMBNAIL/Contents/Info.plist"
if [[ "$MODE" != view ]]; then
    /usr/libexec/PlistBuddy -c "Set :NSExtension:NSExtensionPrincipalClass PreviewProvider" "$EXTENSION/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :NSExtension:NSExtensionAttributes:QLIsDataBasedPreview true" "$EXTENSION/Contents/Info.plist"
    mkdir -p "$EXTENSION/Contents/Resources"
    cp "$SOURCE_DIR/StaticFixture.html" "$EXTENSION/Contents/Resources/"
    if [[ "$MODE" == data-static ]]; then
        /usr/libexec/PlistBuddy -c "Add :SimpleMDStaticFixture bool true" "$EXTENSION/Contents/Info.plist"
    else
        bun build "$SOURCE_DIR/parser-entry.ts" --target browser --format iife \
            --outfile "$EXTENSION/Contents/Resources/parser.js"
        python3 - "$SOURCE_DIR/../../node_modules/katex/dist" "$EXTENSION/Contents/Resources/katex-inline.css" <<'PYFONT'
import base64, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
css = (root / 'katex.min.css').read_text()
def inline(match):
    font = root / match[1]
    return 'src:url(data:font/woff2;base64,' + base64.b64encode(font.read_bytes()).decode() + ') format("woff2");'
css = re.sub(r'src:url\(([^)]*\.woff2)\)[^;]*;', inline, css)
pathlib.Path(sys.argv[2]).write_text(css)
PYFONT
    fi
fi
plutil -lint "$APP/Contents/Info.plist" "$EXTENSION/Contents/Info.plist" \
    "$THUMBNAIL/Contents/Info.plist" "$SOURCE_DIR/thumbnail/thumbnail.entitlements" \
    "$SOURCE_DIR/host.entitlements" "$SOURCE_DIR/$ENTITLEMENTS"

PREVIEW_SOURCES=("$SOURCE_DIR/$PREVIEW_SOURCE")
if [[ "$MODE" != view ]]; then PREVIEW_SOURCES+=("$SOURCE_DIR/ParserRenderer.swift"); fi
for ARCH in arm64 x86_64; do
    xcrun swiftc -sdk "$SDK" -target "$ARCH-apple-macos13.0" \
        -module-cache-path "$OUTPUT_DIR/module-cache" -parse-as-library \
        -framework Cocoa "$SOURCE_DIR/Host.swift" -o "$OUTPUT_DIR/Host-$ARCH"
    xcrun swiftc -sdk "$SDK" -target "$ARCH-apple-macos13.0" \
        -module-cache-path "$OUTPUT_DIR/module-cache" -parse-as-library \
        -application-extension -module-name SimpleMDQLPreview \
        -framework Cocoa -framework QuickLookUI -framework WebKit -framework JavaScriptCore \
        -Xlinker -e -Xlinker _NSExtensionMain \
        "${PREVIEW_SOURCES[@]}" -o "$OUTPUT_DIR/Preview-$ARCH"
    xcrun swiftc -sdk "$SDK" -target "$ARCH-apple-macos13.0" \
        -module-cache-path "$OUTPUT_DIR/module-cache" -parse-as-library \
        -application-extension -module-name SimpleMDQLThumbnail \
        -framework Foundation -framework QuickLookThumbnailing -framework CoreText -framework CoreGraphics \
        -Xlinker -e -Xlinker _NSExtensionMain \
        "$SOURCE_DIR/thumbnail/ThumbnailCard.swift" "$SOURCE_DIR/thumbnail/ThumbnailProvider.swift" \
        -o "$OUTPUT_DIR/Thumbnail-$ARCH"
done
xcrun lipo -create "$OUTPUT_DIR/Host-arm64" "$OUTPUT_DIR/Host-x86_64" \
    -output "$APP/Contents/MacOS/SimpleMDQLHost"
xcrun lipo -create "$OUTPUT_DIR/Preview-arm64" "$OUTPUT_DIR/Preview-x86_64" \
    -output "$EXTENSION/Contents/MacOS/SimpleMDQLPreview"
xcrun lipo -create "$OUTPUT_DIR/Thumbnail-arm64" "$OUTPUT_DIR/Thumbnail-x86_64" \
    -output "$THUMBNAIL/Contents/MacOS/SimpleMDQLThumbnail"

# Sign inner code first. Never replace these entitlements with Electron's.
codesign --force --sign "$IDENTITY" --options runtime --timestamp \
    --entitlements "$SOURCE_DIR/$ENTITLEMENTS" "$EXTENSION"
codesign --force --sign "$IDENTITY" --options runtime --timestamp \
    --entitlements "$SOURCE_DIR/thumbnail/thumbnail.entitlements" "$THUMBNAIL"
codesign --force --sign "$IDENTITY" --options runtime --timestamp \
    --entitlements "$SOURCE_DIR/host.entitlements" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
echo "Built and signed: $APP"
