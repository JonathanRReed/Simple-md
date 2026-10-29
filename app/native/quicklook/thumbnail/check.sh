#!/bin/bash
set -euo pipefail
source_dir="$(cd "$(dirname "$0")" && pwd)"
scratch="$(mktemp -d /tmp/simplemd-thumbnail-check.XXXXXX)"
trap 'python3 -c '\''import shutil,sys; shutil.rmtree(sys.argv[1])'\'' "$scratch"' EXIT
xcrun swiftc -sdk "$(xcrun --sdk macosx --show-sdk-path)" -parse-as-library \
    -module-cache-path "$scratch/module-cache" -framework CoreText -framework CoreGraphics -framework ImageIO \
    "$source_dir/ThumbnailCard.swift" "$source_dir/Tests.swift" -o "$scratch/check"
"$scratch/check" "$@"
