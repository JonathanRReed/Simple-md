#!/bin/bash
set -euo pipefail
source_dir="$(cd "$(dirname "$0")" && pwd)"
scratch="$(mktemp -d /tmp/simplemd-preview-check.XXXXXX)"
trap 'rm -rf "$scratch"' EXIT
xcrun swiftc -O -sdk "$(xcrun --sdk macosx --show-sdk-path)" -parse-as-library \
    -module-cache-path "$scratch/module-cache" -framework Foundation -framework JavaScriptCore \
    "$source_dir/PreviewSource.swift" "$source_dir/StaticRenderer.swift" "$source_dir/Tests.swift" -o "$scratch/check"
"$scratch/check" "$1"
