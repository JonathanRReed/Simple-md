#!/bin/bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
    echo "Usage: $0 new-output-directory [signing-identity-or--]" >&2
    exit 2
fi
source_dir="$(cd "$(dirname "$0")" && pwd)"
mkdir "$1"
output="$(cd "$1" && pwd)"
identity="${2:--}"
sdk="$(xcrun --sdk macosx --show-sdk-path)"
scratch="$(mktemp -d /tmp/simplemd-ql-build.XXXXXX)"
trap 'rm -rf "$scratch"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for kind in Preview Thumbnail; do
    extension="$output/SimpleMDQL$kind.appex"
    mkdir -p "$extension/Contents/MacOS"
    if [[ "$kind" == Preview ]]; then
        cp "$source_dir/preview/Info.plist" "$extension/Contents/Info.plist"
        sources=("$source_dir/preview/PreviewProvider.swift" "$source_dir/preview/PreviewSource.swift" "$source_dir/preview/StaticRenderer.swift")
        frameworks=(-framework Cocoa -framework QuickLookUI -framework JavaScriptCore -framework ImageIO)
        mkdir -p "$extension/Contents/Resources"
        bun build "$source_dir/../../src/shared/render-browser.ts" --target browser --format iife --minify \
            --outfile "$extension/Contents/Resources/render-core.js"
    else
        cp "$source_dir/thumbnail/Info.plist" "$extension/Contents/Info.plist"
        sources=("$source_dir/thumbnail/ThumbnailCard.swift" "$source_dir/thumbnail/ThumbnailProvider.swift")
        frameworks=(-framework Foundation -framework QuickLookThumbnailing -framework CoreText -framework CoreGraphics)
    fi
    plutil -lint "$extension/Contents/Info.plist" "$source_dir/extension.entitlements"
    for arch in arm64 x86_64; do
        xcrun swiftc -O -sdk "$sdk" -target "$arch-apple-macos13.0" \
            -module-cache-path "$scratch/module-cache" -parse-as-library -application-extension \
            -module-name "SimpleMDQL$kind" "${frameworks[@]}" \
            -Xlinker -e -Xlinker _NSExtensionMain "${sources[@]}" -o "$scratch/$kind-$arch"
    done
    xcrun lipo -create "$scratch/$kind-arm64" "$scratch/$kind-x86_64" \
        -output "$extension/Contents/MacOS/SimpleMDQL$kind"
    timestamp=(--timestamp=none)
    if [[ "$identity" != - ]]; then timestamp=(--timestamp); fi
    codesign --force --sign "$identity" --options runtime "${timestamp[@]}" \
        --entitlements "$source_dir/extension.entitlements" "$extension"
    codesign --verify --strict --verbose=2 "$extension"
done
