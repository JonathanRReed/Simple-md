#!/bin/bash
set -euo pipefail
build="$1"
label="$2"
fixture="${3:-$PWD/app/native/quicklook/fixtures/fixture.md}"
evidence="$PWD/app/native/quicklook/evidence/followup"
app="$HOME/Applications/SimpleMDQLFollowup.app"
plugin="$app/Contents/PlugIns/SimpleMDQLPreview.appex"
lsreg=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
id=com.jonathanreed.simplemd.qlspike
[[ ! -e "$app" ]] || exit 2
qlpid=''
cleanup() {
    set +e
    [[ -z "$qlpid" ]] || kill "$qlpid"
    pluginkit -e default -i com.xykong.Markdown.QuickLook
    pluginkit -e default -i "$id.preview"
    pluginkit -r "$plugin"
    "$lsreg" -u "$app"
    "$lsreg" -u "$build/SimpleMDQLSpike.app"
    # Only terminate processes executing our exact copied extension.
    pgrep -f "^$plugin/Contents/MacOS/SimpleMDQLPreview" | xargs -r kill
    python3 - "$app" "$HOME/Library/Containers/$id" "$HOME/Library/Containers/$id.preview" <<'PY'
import shutil,sys
for p in sys.argv[1:]:
    print('REMOVE',p)
    if __import__("os").path.exists(p): shutil.rmtree(p)
PY
    pluginkit -m -A -D -vv -i com.xykong.Markdown.QuickLook
    pluginkit -m -A -D -vv -i "$id.preview"
}
trap 'cleanup >> "$evidence/$label-cleanup.txt" 2>&1' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
pluginkit -m -A -D -vv -i com.xykong.Markdown.QuickLook > "$evidence/$label-before.txt"
ditto "$build/SimpleMDQLSpike.app" "$app"
"$lsreg" -f "$app"
open -n "$app"
sleep 1
pluginkit -a "$plugin"
pluginkit -e use -i "$id.preview"
pluginkit -e ignore -i com.xykong.Markdown.QuickLook
pluginkit -m -A -D -vv -i "$id.preview" > "$evidence/$label-registration.txt"
codesign -d --entitlements :- "$plugin" > "$evidence/$label-entitlements.txt" 2>&1
start="$(date '+%Y-%m-%d %H:%M:%S')"
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$evidence/$label-start.txt"
python3 -c "import time; print(time.time())" > "$evidence/$label-launch-seconds.txt"
qlmanage -p "$fixture" > "$evidence/$label-qlmanage.txt" 2>&1 &
qlpid=$!
sleep 3
/tmp/simplemd-ql-followup-windows | python3 -c 'import sys,json; [print(s,end="") for s in sys.stdin if json.loads(s)["kCGWindowOwnerName"] in ["qlmanage","QuickLookUIService"]]' > "$evidence/$label-windows.jsonl"
window=$(python3 - "$evidence/$label-windows.jsonl" <<'PY'
import json,sys
ws=[json.loads(s) for s in open(sys.argv[1])]
ws=[w for w in ws if w['kCGWindowOwnerName'] in ['qlmanage','QuickLookUIService'] and w['kCGWindowBounds']['Height']>100]
assert len(ws)==1,ws
print(ws[0]['kCGWindowNumber'])
PY
)
screencapture -x -o -l "$window" "$evidence/$label-panel.png"
python3 -c "import time; print(time.time())" > "$evidence/$label-capture-seconds.txt"
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$evidence/$label-captured.txt"
/usr/bin/log show --start "$start" --style compact --info --debug --predicate 'subsystem == "com.jonathanreed.simplemd.qlspike" OR (process == "sandboxd" AND eventMessage CONTAINS "SimpleMDQL") OR (process == "SimpleMDQLPreview" AND messageType == error)' > "$evidence/$label-runtime.txt" 2>&1
