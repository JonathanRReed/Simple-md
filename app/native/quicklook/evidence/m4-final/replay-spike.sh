#!/bin/bash
set -euo pipefail
# Rebuild only the historical thumbnail host, using its exact source and plists.
source_dir="$(cd "$(dirname "$0")/../.." && pwd)"
repo="$(cd "$source_dir/../../.." && pwd)"
mkdir "$1"
evidence="$(cd "$1" && pwd)"
scratch="$(mktemp -d /tmp/simplemd-m4-spike-replay.XXXXXX)"
installed="$HOME/Applications/SimpleMD-M4-SpikeReplay.app"
id=com.jonathanreed.simplemd.qlspike
flux=com.xykong.Markdown.QuickLook
lsreg=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[[ ! -e "$installed" ]]
for suffix in thumbnail preview; do
 [[ ! -e "$HOME/Library/Containers/$id.$suffix" ]]
 pluginkit -m -A -D -vv -i "$id.$suffix" > "$evidence/$suffix-before.txt" 2>&1 || true
 grep -q '(no matches)' "$evidence/$suffix-before.txt"
done
[[ ! -e "$HOME/Library/Containers/$id" ]]
pluginkit -m -A -D -vv -i "$flux" > "$evidence/flux-before.txt"
cleanup() {
 status=$?
 trap - EXIT
 set +e
 {
  pluginkit -e default -i "$flux"
  pluginkit -e default -i "$id.thumbnail"
  pluginkit -r "$installed/Contents/PlugIns/SimpleMDQLThumbnail.appex"
  pgrep -f "^$installed/Contents/PlugIns/SimpleMDQLThumbnail.appex/Contents/MacOS/SimpleMDQLThumbnail" | xargs -r kill
  "$lsreg" -u "$installed"
  python3 - "$installed" "$scratch" "$HOME/Library/Containers/$id" "$HOME/Library/Containers/$id.thumbnail" <<'PY'
from pathlib import Path
import shutil,sys
for argument in sys.argv[1:]:
 p=Path(argument);print('REMOVE',p,'existed='+str(p.exists()))
 if p.exists(): shutil.rmtree(p)
PY
  qlmanage -r cache
  pluginkit -m -A -D -vv -i "$flux" > "$evidence/flux-after.txt"
  diff -u "$evidence/flux-before.txt" "$evidence/flux-after.txt" || status=1
  pluginkit -m -A -D -vv -i "$id.thumbnail" > "$evidence/thumbnail-after.txt" 2>&1
  grep -q '(no matches)' "$evidence/thumbnail-after.txt" || status=1
  "$lsreg" -dump | grep -F "$installed" > "$evidence/launchservices-after.txt"
  [[ ! -s "$evidence/launchservices-after.txt" ]] || status=1
  echo "Final status: $status"
 } > "$evidence/cleanup.txt" 2>&1
 exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$installed/Contents/MacOS" "$installed/Contents/PlugIns/SimpleMDQLThumbnail.appex/Contents/MacOS"
for file in Host.swift Host-Info.plist thumbnail/ThumbnailProvider.swift thumbnail/ThumbnailCard.swift thumbnail/Info.plist; do
 mkdir -p "$scratch/$(dirname "$file")"
 git -C "$repo" show "52a936a:app/native/quicklook/$file" > "$scratch/$file"
done
cp "$scratch/Host-Info.plist" "$installed/Contents/Info.plist"
cp "$scratch/thumbnail/Info.plist" "$installed/Contents/PlugIns/SimpleMDQLThumbnail.appex/Contents/Info.plist"
xcrun swiftc -O -parse-as-library -framework Cocoa "$scratch/Host.swift" -o "$installed/Contents/MacOS/SimpleMDQLHost"
xcrun swiftc -O -parse-as-library -application-extension -module-name SimpleMDQLThumbnail \
 -framework Foundation -framework QuickLookThumbnailing -framework CoreText -framework CoreGraphics \
 -Xlinker -e -Xlinker _NSExtensionMain "$scratch/thumbnail/ThumbnailCard.swift" "$scratch/thumbnail/ThumbnailProvider.swift" \
 -o "$installed/Contents/PlugIns/SimpleMDQLThumbnail.appex/Contents/MacOS/SimpleMDQLThumbnail"
identity='Developer ID Application: Jonathan Reed (AJ9VWBRNZN)'
codesign --force --sign "$identity" --timestamp --options runtime --entitlements "$source_dir/extension.entitlements" "$installed/Contents/PlugIns/SimpleMDQLThumbnail.appex"
codesign --force --sign "$identity" --timestamp --options runtime --entitlements "$source_dir/host.entitlements" "$installed"
codesign --verify --deep --strict --verbose=2 "$installed"
cp "$scratch/Host-Info.plist" "$evidence/Host-Info.plist"
cp "$scratch/thumbnail/Info.plist" "$evidence/Thumbnail-Info.plist"
"$lsreg" -f -v "$installed" > "$evidence/registration.txt" 2>&1
open -n "$installed"
pluginkit -a "$installed/Contents/PlugIns/SimpleMDQLThumbnail.appex"
pluginkit -e use -i "$id.thumbnail"
pluginkit -m -A -D -vv -i "$id.thumbnail" >> "$evidence/registration.txt"
qlmanage -r cache
start="$(date '+%Y-%m-%d %H:%M:%S')"
mkdir "$evidence/thumbnails"
for name in README.md fixture.mdx; do
 printf '# Historical thumbnail host\n\nExact M0 source and declarations.\n' > "$evidence/$name"
 qlmanage -t -x -s 512 -o "$evidence/thumbnails" "$evidence/$name" > "$evidence/$name.txt" 2>&1
done
/usr/bin/log show --start "$start" --style compact --info --debug \
 --predicate 'subsystem == "com.jonathanreed.simplemd.qlspike" OR (process == "com.apple.quicklook.ThumbnailsAgent" AND (eventMessage CONTAINS "simplemd" OR eventMessage CONTAINS "TextExtension"))' \
 > "$evidence/runtime.txt" 2>&1
