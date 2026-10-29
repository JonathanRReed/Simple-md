#!/bin/bash
set -euo pipefail

if [[ $# != 2 ]]; then
    echo "Usage: $0 build-directory new-evidence-directory" >&2
    exit 2
fi
build="$(cd "$1" && pwd)"
mkdir "$2"
evidence="$(cd "$2" && pwd)"
source_dir="$(cd "$(dirname "$0")" && pwd)"
app="$HOME/Applications/SimpleMDQLThumbnailSpike.app"
id=com.jonathanreed.simplemd.qlspike
flux=com.xykong.Markdown.QuickLook
lsreg=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[[ -d "$build/SimpleMDQLSpike.app" && ! -e "$app" ]]
for bundle in "$id" "$id.preview" "$id.thumbnail"; do
    [[ ! -e "$HOME/Library/Containers/$bundle" ]]
done
for suffix in preview thumbnail; do
    pluginkit -m -A -D -vv -i "$id.$suffix" > "$evidence/$suffix-before.txt" 2>&1 || true
    grep -q '(no matches)' "$evidence/$suffix-before.txt"
done
pluginkit -m -A -D -vv -i "$flux" > "$evidence/flux-before.txt"
qlmanage -m plugins > "$evidence/providers-before.txt"
qlpid=''
cleanup() {
    status=$?
    trap - EXIT
    set +e
    {
        [[ -z "$qlpid" ]] || kill "$qlpid"
        pluginkit -e default -i "$flux"
        for suffix in preview thumbnail; do
            pluginkit -e default -i "$id.$suffix"
        done
        for name in SimpleMDQLPreview SimpleMDQLThumbnail; do
            plugin="$app/Contents/PlugIns/$name.appex"
            pluginkit -r "$plugin"
            # Match only processes running the copy this script installed.
            pgrep -f "^$plugin/Contents/MacOS/$name" | xargs -r kill
        done
        "$lsreg" -u "$app"
        "$lsreg" -u "$build/SimpleMDQLSpike.app"
        python3 - "$app" "$build/SimpleMDQLSpike.app" \
            "$HOME/Library/Containers/$id" "$HOME/Library/Containers/$id.preview" \
            "$HOME/Library/Containers/$id.thumbnail" <<'PY'
import pathlib, shutil, sys
for argument in sys.argv[1:]:
    path = pathlib.Path(argument)
    print('REMOVE', path, 'existed=' + str(path.exists()))
    if path.exists():
        shutil.rmtree(path)
PY
        qlmanage -r cache
        pluginkit -m -A -D -vv -i "$flux" > "$evidence/flux-after.txt"
        diff -u "$evidence/flux-before.txt" "$evidence/flux-after.txt"
        [[ $? == 0 ]] || status=1
        for suffix in preview thumbnail; do
            pluginkit -m -A -D -vv -i "$id.$suffix" > "$evidence/$suffix-after.txt" 2>&1
            grep -q '(no matches)' "$evidence/$suffix-after.txt" || status=1
        done
        "$lsreg" -dump | grep -F "$id" > "$evidence/launchservices-after.txt"
        [[ ! -s "$evidence/launchservices-after.txt" ]] || status=1
        qlmanage -m plugins > "$evidence/providers-after.txt"
        diff -u "$evidence/providers-before.txt" "$evidence/providers-after.txt"
        [[ $? == 0 ]] || status=1
        for path in "$app" "$build/SimpleMDQLSpike.app" \
            "$HOME/Library/Containers/$id" "$HOME/Library/Containers/$id.preview" \
            "$HOME/Library/Containers/$id.thumbnail"; do
            if [[ -e "$path" ]]; then echo "STILL EXISTS: $path"; status=1; fi
        done
        echo "Final status: $status"
    } >> "$evidence/cleanup.txt" 2>&1
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$HOME/Applications" "$evidence/fixtures" "$evidence/pngs"
cp "$source_dir/../../../README.md" "$evidence/fixtures/README.md"
python3 - "$evidence/fixtures" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
(root / 'no-heading.md').write_text('Opening **words** with an [example](https://example.com).\n\n```swift\nlet snake_case = "*literal*"\nprint(snake_case)\n```\n')
(root / 'frontmatter.mdx').write_text('---\ntitle: This metadata must not appear\ndraft: true\n---\nimport Widget from "./widget.js"\nexport const value = 42\n# A quiet MDX page\nReadable *prose*, with a [local link](./other.md).\n```js\nconst answer = 42;\n```\n')
(root / 'long-line.md').write_text('# A very long line\n' + 'A long line wraps within the paper card. ' * 2000 + '\n# Beyond the read limit\n')
(root / 'empty.md').write_bytes(b'')
(root / 'non-utf8.md').write_bytes(b'# Invalid bytes stay readable\nBefore \xff\xfe after. No decoding crash.\n')
PY
shasum -a 256 "$evidence"/fixtures/* > "$evidence/fixture-sha256.txt"
{
    date -u
    xcode-select -p
    xcrun swiftc --version
    xcrun --sdk macosx --show-sdk-version
    sw_vers
    uptime
    sysctl -n hw.logicalcpu
} > "$evidence/environment.txt"
ditto "$build/SimpleMDQLSpike.app" "$app"
"$lsreg" -f -v "$app" > "$evidence/registration.txt" 2>&1
open -n "$app"
sleep 1
for name in SimpleMDQLPreview SimpleMDQLThumbnail; do
    pluginkit -a "$app/Contents/PlugIns/$name.appex"
done
pluginkit -e use -i "$id.thumbnail"
pluginkit -m -A -D -vv -i "$id.thumbnail" >> "$evidence/registration.txt"
pluginkit -m -A -D -vv -i "$id.preview" >> "$evidence/registration.txt"
{
    codesign --verify --deep --strict --verbose=2 "$app"
    for name in SimpleMDQLHost ../PlugIns/SimpleMDQLPreview.appex/Contents/MacOS/SimpleMDQLPreview \
        ../PlugIns/SimpleMDQLThumbnail.appex/Contents/MacOS/SimpleMDQLThumbnail; do
        xcrun lipo -archs "$app/Contents/MacOS/$name"
        xcrun vtool -show-build "$app/Contents/MacOS/$name"
    done
    codesign -dvvv --entitlements - "$app/Contents/PlugIns/SimpleMDQLThumbnail.appex"
    otool -L "$app/Contents/PlugIns/SimpleMDQLThumbnail.appex/Contents/MacOS/SimpleMDQLThumbnail"
} > "$evidence/signatures.txt" 2>&1
start="$(date '+%Y-%m-%d %H:%M:%S')"
qlmanage -r cache > "$evidence/cache-reset.txt"
python3 - "$evidence" <<'PY'
from pathlib import Path
import json, struct, subprocess, sys, time
root = Path(sys.argv[1])
results = []
for fixture in ['README.md', 'no-heading.md', 'frontmatter.mdx', 'long-line.md', 'empty.md', 'non-utf8.md']:
    command = ['qlmanage', '-t', '-x', '-s', '512', '-o', str(root / 'pngs'), str(root / 'fixtures' / fixture)]
    started = time.perf_counter()
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    elapsed = (time.perf_counter() - started) * 1000
    (root / (fixture + '-qlmanage.txt')).write_text(result.stdout + result.stderr)
    png = root / 'pngs' / (fixture + '.png')
    assert result.returncode == 0 and png.exists(), (fixture, result)
    header = png.read_bytes()[:24]
    assert header[:8] == b'\x89PNG\r\n\x1a\n'
    width, height = struct.unpack('>II', header[16:24])
    assert (width, height) == (512, 512), (fixture, width, height)
    results.append(dict(fixture=fixture, milliseconds=round(elapsed, 3), width=width, height=height, exit_code=result.returncode))
(root / 'timings.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results, indent=2))
PY
for variant in small retina; do
    mkdir "$evidence/$variant"
    cp "$evidence/fixtures/no-heading.md" "$evidence/fixtures/$variant.md"
done
qlmanage -t -x -s 128 -o "$evidence/small" "$evidence/fixtures/small.md" > "$evidence/small-qlmanage.txt" 2>&1
qlmanage -t -x -s 256 -f 2 -o "$evidence/retina" "$evidence/fixtures/retina.md" > "$evidence/retina-qlmanage.txt" 2>&1
# Exercise the existing preview beside the thumbnail. Its competitor is restored by the EXIT trap.
pluginkit -e ignore -i "$flux"
pluginkit -e use -i "$id.preview"
qlmanage -p "$evidence/fixtures/no-heading.md" > "$evidence/preview-qlmanage.txt" 2>&1 &
qlpid=$!
sleep 4
kill "$qlpid" 2>/dev/null || true
wait "$qlpid" || true
qlpid=''
pluginkit -e default -i "$flux"
sleep 1
/usr/bin/log show --start "$start" --style compact --info --debug \
    --predicate 'subsystem == "com.jonathanreed.simplemd.qlspike" OR (process == "sandboxd" AND eventMessage CONTAINS "SimpleMDQL") OR (process == "secinitd" AND eventMessage CONTAINS "SimpleMDQL")' \
    > "$evidence/runtime.txt" 2>&1
for fixture in README.md no-heading.md frontmatter.mdx long-line.md empty.md non-utf8.md; do
    grep -F "Thumbnail drawn file=$fixture " "$evidence/runtime.txt"
done
grep -E 'Data ready bytes=|Preview ready' "$evidence/runtime.txt"
python3 - "$evidence" <<'PY'
from pathlib import Path
import struct, sys
root = Path(sys.argv[1])
for variant, expected in [('small', 128), ('retina', 512)]:
    data = (root / variant / (variant + '.md.png')).read_bytes()
    size = struct.unpack('>II', data[16:24])
    assert size == (expected, expected), (variant, size)
    assert 'Thumbnail drawn file=' + variant + '.md ' in (root / 'runtime.txt').read_text()
    print(variant, size)
PY
bash "$source_dir/check.sh" "$evidence/small/small.md.png" "$evidence/retina/retina.md.png" \
    > "$evidence/content-check.txt" 2>&1
