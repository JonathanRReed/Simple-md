#!/bin/bash
set -euo pipefail
if [[ $# != 2 ]]; then
    echo "Usage: $0 packaged-app new-evidence-directory" >&2
    exit 2
fi
source_app="$(cd "$1" && pwd)"
mkdir "$2"
evidence="$(cd "$2" && pwd)"
source_dir="$(cd "$(dirname "$0")" && pwd)"
installed="$HOME/Applications/SimpleMD-M4-final.app"
id=com.jonathanreed.simplemd
flux=com.xykong.Markdown.QuickLook
lsreg=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[[ -d "$source_app/Contents/PlugIns" && ! -e "$installed" ]]
for suffix in preview thumbnail; do
    [[ ! -e "$HOME/Library/Containers/$id.$suffix" ]]
    pluginkit -m -A -D -vv -i "$id.$suffix" > "$evidence/$suffix-before.txt" 2>&1 || true
    grep -q '(no matches)' "$evidence/$suffix-before.txt"
done
pluginkit -m -A -D -vv -i "$flux" > "$evidence/flux-before.txt"
grep -q '^     com.xykong.Markdown.QuickLook' "$evidence/flux-before.txt"
run_started="$(date '+%Y-%m-%d %H:%M:%S')"
scratch="$(mktemp -d /tmp/simplemd-m4-test.XXXXXX)"
cleanup() {
    status=$?
    trap - EXIT
    set +e
    {
        /usr/bin/log show --start "$run_started" --style compact --info --debug \
          --predicate 'subsystem == "com.jonathanreed.simplemd.quicklook" OR (process == "sandboxd" AND eventMessage CONTAINS "SimpleMDQL") OR (process == "secinitd" AND eventMessage CONTAINS "SimpleMDQL") OR (process == "com.apple.quicklook.ThumbnailsAgent" AND (eventMessage CONTAINS "simplemd" OR eventMessage CONTAINS "TextExtension"))' \
          > "$evidence/runtime-cleanup.txt" 2>&1
        pluginkit -e default -i "$flux"
        for suffix in preview thumbnail; do
            pluginkit -e default -i "$id.$suffix"
        done
        for name in SimpleMDQLPreview SimpleMDQLThumbnail; do
            plugin="$installed/Contents/PlugIns/$name.appex"
            pluginkit -r "$plugin"
            pgrep -f "^$plugin/Contents/MacOS/$name" | xargs -r kill
        done
        "$lsreg" -u "$installed"
        "$lsreg" -u "$source_app"
        python3 - "$installed" "$scratch" "$HOME/Library/Containers/$id.preview" "$HOME/Library/Containers/$id.thumbnail" <<'PY'
import pathlib, shutil, sys
for argument in sys.argv[1:]:
    path = pathlib.Path(argument)
    print('REMOVE', path, 'existed=' + str(path.exists()))
    if path.exists():
        shutil.rmtree(path)
PY
        qlmanage -r cache
        pluginkit -m -A -D -vv -i "$flux" > "$evidence/flux-after.txt"
        diff -u "$evidence/flux-before.txt" "$evidence/flux-after.txt" || status=1
        for suffix in preview thumbnail; do
            pluginkit -m -A -D -vv -i "$id.$suffix" > "$evidence/$suffix-after.txt" 2>&1
            grep -q '(no matches)' "$evidence/$suffix-after.txt" || status=1
            [[ ! -e "$HOME/Library/Containers/$id.$suffix" ]] || status=1
        done
        "$lsreg" -dump | grep -F "$installed" > "$evidence/launchservices-after.txt"
        [[ ! -s "$evidence/launchservices-after.txt" ]] || status=1
        [[ ! -e "$installed" && ! -e "$scratch" ]] || status=1
        echo "Final status: $status"
    } >> "$evidence/cleanup.txt" 2>&1
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$HOME/Applications"
{
    date -u
    git rev-parse HEAD
    git status --short
    xcode-select -p
    xcrun swiftc --version
    xcrun --sdk macosx --show-sdk-version
    sw_vers
    uptime
    sysctl -n hw.logicalcpu
    ps -axo pid=,comm= | grep '/SimpleMD.app/Contents/MacOS/SimpleMD$' || true
} > "$evidence/environment.txt"
xcrun swiftc "$source_dir/evidence/followup/windows.swift" -o "$scratch/windows"
ditto "$source_app" "$installed"
"$lsreg" -f -v "$installed" > "$evidence/registration.txt" 2>&1
for name in SimpleMDQLPreview SimpleMDQLThumbnail; do
    pluginkit -a "$installed/Contents/PlugIns/$name.appex"
done
for suffix in preview thumbnail; do
    pluginkit -e use -i "$id.$suffix"
    pluginkit -m -A -D -vv -i "$id.$suffix" >> "$evidence/registration.txt"
done
pluginkit -e ignore -i "$flux"
qlmanage -r cache > "$evidence/cache-reset.txt"
bun "$source_dir/../../build/quicklook-verify.mjs" "$installed" > "$evidence/verify-installed.txt" 2>&1
for name in SimpleMDQLPreview SimpleMDQLThumbnail; do
    codesign -dvvv --entitlements - "$installed/Contents/PlugIns/$name.appex" >> "$evidence/signatures.txt" 2>&1
    xcrun vtool -show-build "$installed/Contents/PlugIns/$name.appex/Contents/MacOS/$name" >> "$evidence/signatures.txt"
done
python3 "$source_dir/test-packaged.py" "$evidence" "$scratch/windows" "$source_dir/../../../README.md"
