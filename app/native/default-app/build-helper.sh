#!/bin/bash
set -euo pipefail
source_dir="$(cd "$(dirname "$0")" && pwd)"
output="${1:?Supply an output path}"
scratch="$(mktemp -d /tmp/simplemd-default-app.XXXXXX)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$(dirname "$output")"
xcrun swiftc -O -parse-as-library -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
    -target arm64-apple-macos13.0 -module-cache-path "$scratch/module-cache" \
    -framework AppKit -framework UniformTypeIdentifiers \
    "$source_dir/DefaultApp.swift" -o "$output"
