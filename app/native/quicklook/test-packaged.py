"""Exercise one registered package. The calling shell owns registration and cleanup."""
from pathlib import Path
import datetime
import hashlib
import json
import re
import struct
import subprocess
import sys
import time
import zlib

root, windows, readme = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
fixtures = root / "fixtures"
panels = root / "panels"
pngs = root / "thumbnails"
for directory in [fixtures, panels, pngs]:
    directory.mkdir()
(fixtures / "README.md").write_bytes(readme.read_bytes())
(fixtures / "math.md").write_text("# Math\n\n$E = mc^2$\n\n$$\\frac{1}{2}$$\n")
(fixtures / "mermaid.md").write_text("# A Mermaid fence\n\n~~~mermaid\ngraph TD\n  A --> B\n~~~\n")
(fixtures / "local-image.md").write_text("# A local image\n\n![Local red dot](./dot.png)\n\n![Remote image](https://example.com/no-network.png)\n")
def chunk(kind, content):
    return struct.pack(">I", len(content)) + kind + content + struct.pack(">I", zlib.crc32(kind + content))


(fixtures / "dot.png").write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 96, 96, 8, 2, 0, 0, 0)) +
                                    chunk(b"IDAT", zlib.compress((b"\0" + b"\xdd\x33\x33" * 96) * 96)) + chunk(b"IEND", b""))
(fixtures / "fixture.mdx").write_text('---\ntitle: MDX\n---\nimport Widget from "./widget.js"\n\n# An inert MDX page\n\n<Widget onClick={() => alert("never")} />\n')
(fixtures / "large.md").write_bytes(b"# A bounded large file\n" + b"Only the first four megabytes appear.\n" * 125000 + b"TAIL MUST NOT APPEAR\n")
(fixtures / "empty.md").write_bytes(b"")
(fixtures / "non-utf8.md").write_bytes(b"# Invalid bytes\nBefore \xff\xfe after.\n")
(fixtures / "not-markdown.txt").write_text("Plain text stays with the system provider.\n")
hostile = readme.parent / "app/test/sanitizer/fixtures.ts"
# Preserve the active-tags fixture verbatim, instead of inventing another sanitizer case.
active = re.search(r'name: "active tags", source: \'(.*?)\', expected:', hostile.read_text()).group(1)
(fixtures / "hostile.md").write_text("# Hostile author HTML\n\n" + active + "\n")
(root / "fixture-sha256.json").write_text(json.dumps({
    p.name: dict(bytes=p.stat().st_size, sha256=hashlib.sha256(p.read_bytes()).hexdigest())
    for p in fixtures.iterdir()
}, indent=2) + "\n")


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=40, **kwargs)


def window_list():
    return [json.loads(line) for line in run([windows]).stdout.splitlines()]


def main_processes():
    lines = run(["ps", "-axo", "pid=,comm="]).stdout.splitlines()
    return [line for line in lines if line.rstrip().endswith("/Contents/MacOS/SimpleMD")]


assert not main_processes(), main_processes()
start = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
results = []
for filename in ["README.md", "math.md", "mermaid.md", "local-image.md", "fixture.mdx",
                 "large.md", "empty.md", "non-utf8.md", "hostile.md", "readable-image.md", "not-markdown.txt"]:
    fixture = fixtures / filename
    if filename == "readable-image.md":
        # A second sandbox case: the extension already owns this container folder.
        folder = Path.home() / "Library/Containers/com.jonathanreed.simplemd.preview/Data/Documents/m4-final-image"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "dot.png").write_bytes((fixtures / "dot.png").read_bytes())
        fixture = folder / filename
        fixture.write_text("# A readable local image\n\n![Readable red square](dot.png)\n\n![Missing sibling](missing.png)\n")
        (root / "readable-image-path.txt").write_text(str(fixture) + "\n")
    # Request the thumbnail before preview generation can populate the shared cache.
    tick = time.perf_counter()
    thumbnail = run(["qlmanage", "-t", "-x", "-s", "512", "-o", str(pngs), str(fixture)])
    thumbnail_ms = (time.perf_counter() - tick) * 1000
    (root / (filename + "-thumbnail.txt")).write_text(thumbnail.stdout + thumbnail.stderr)
    image = pngs / (filename + ".png")
    assert image.exists(), filename
    dimensions = struct.unpack(">II", image.read_bytes()[16:24])
    assert max(dimensions) == 512, (filename, dimensions)
    before = {w["kCGWindowNumber"] for w in window_list()}
    with (root / (filename + "-preview.txt")).open("w") as output:
        launched = time.time()
        process = subprocess.Popen(["qlmanage", "-p", str(fixture)], stdout=output, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 60
            candidates = []
            while time.monotonic() < deadline:
                candidates = [w for w in window_list() if w["kCGWindowNumber"] not in before
                          and w["kCGWindowOwnerName"] in ["qlmanage", "QuickLookUIService", "Quick Look"]
                          and w["kCGWindowBounds"]["Height"] > 100]
                if candidates:
                    break
                if process.poll() is not None:
                    break
                time.sleep(0.2)
            # Allow layout and fonts to settle after the panel appears.
            time.sleep(5)
            (root / (filename + "-windows.json")).write_text(json.dumps(candidates, indent=2) + "\n")
            assert len(candidates) == 1, (filename, candidates)
            run(["screencapture", "-x", "-o", "-l", str(candidates[0]["kCGWindowNumber"]),
                 str(panels / (filename + ".png"))])
            capture_ms = (time.time() - launched) * 1000
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    results.append(dict(fixture=filename, preview_launch_epoch=launched,
                        capture_bound_ms=round(capture_ms, 3),
                        thumbnail_wall_ms=round(thumbnail_ms, 3), thumbnail_pixels=dimensions))
    (root / "timings.json").write_text(json.dumps(results, indent=2) + "\n")

runtime = run(["/usr/bin/log", "show", "--start", start, "--style", "compact", "--info", "--debug",
               "--predicate", 'subsystem == "com.jonathanreed.simplemd.quicklook" OR '
               '(process == "sandboxd" AND eventMessage CONTAINS "SimpleMDQL") OR '
               '(process == "secinitd" AND eventMessage CONTAINS "SimpleMDQL") OR '
               '(process == "com.apple.quicklook.ThumbnailsAgent" AND (eventMessage CONTAINS "simplemd" OR eventMessage CONTAINS "TextExtension"))'])
(root / "runtime.txt").write_text(runtime.stdout + runtime.stderr)
failures = [line for line in runtime.stdout.splitlines() if "Preview failed file=" in line]
for result in results:
    name = re.escape(result["fixture"])
    preview = re.findall(r"Preview ready file=" + name + r" .*?elapsed_ms=([0-9.]+)", runtime.stdout)
    drawn = re.findall(r"Thumbnail drawn file=" + name + r" elapsed_ms=([0-9.]+)", runtime.stdout)
    if result["fixture"].endswith(".txt"):
        if preview or drawn:
            failures.append(result["fixture"] + ": SimpleMD claimed plain text")
    else:
        if not preview:
            failures.append(result["fixture"] + ": no SimpleMD preview receipt")
        if not drawn:
            # Markdown may route to the system provider. Record this separately
            # from the renderer gate and require MDX to retain its native card.
            if result["fixture"].endswith(".mdx"):
                failures.append(result["fixture"] + ": no SimpleMD thumbnail receipt")
    if preview:
        ready_line = next(line for line in runtime.stdout.splitlines() if "Preview ready file=" + result["fixture"] + " " in line)
        ready_date = " ".join(ready_line.split()[:2])
        ready_epoch = datetime.datetime.strptime(ready_date, "%Y-%m-%d %H:%M:%S.%f").timestamp()
        result["launch_to_reply_ms"] = round((ready_epoch - result["preview_launch_epoch"]) * 1000, 3)
        result["preview_provider_ms"] = float(preview[-1])
    if drawn:
        result["thumbnail_provider_ms"] = float(drawn[-1])
    result["simplemd_preview"] = bool(preview)
    result["simplemd_thumbnail"] = bool(drawn)
assert "read_bytes=4194304 truncated=true" in runtime.stdout
assert re.search(r"Preview ready file=non-utf8.md .*invalid_utf8=true", runtime.stdout)
assert "images_requested=1 images_embedded=0" in runtime.stdout, "No sandbox sibling denial receipt"
assert "images_requested=2 images_embedded=1" in runtime.stdout, "No sandbox readable image receipt"
assert not main_processes(), main_processes()
(root / "timings.json").write_text(json.dumps(results, indent=2) + "\n")
(root / "main-app-closed.txt").write_text("No process executable ending /Contents/MacOS/SimpleMD before or after the complete fixture sequence.\n")
print(json.dumps(results, indent=2))
assert not failures, failures
