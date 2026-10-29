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
results = []
predicate = ('subsystem == "com.jonathanreed.simplemd.quicklook" OR '
             '(process == "com.apple.quicklook.ThumbnailsAgent") OR '
             '(eventMessage CONTAINS "TextExtension")')


def logs(start):
    time.sleep(1)
    return run(["/usr/bin/log", "show", "--start", start, "--style", "compact", "--info", "--debug",
                "--predicate", predicate]).stdout


# Test the requested local qlmanage path first. Server mode is a separate diagnostic.
for filename in ["README.md", "fixture.mdx"]:
    fixture = fixtures / filename
    started = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    run(["qlmanage", "-r", "cache"])
    output = run(["qlmanage", "-t", "-s", "512", "-o", str(pngs), str(fixture)])
    (root / (filename + "-thumbnail.txt")).write_text(output.stdout + output.stderr)
    runtime = logs(started)
    (root / (filename + "-thumbnail-runtime.txt")).write_text(runtime)
    simplemd = "Thumbnail drawn file=" in runtime
    apple = "com.apple.quicklook.thumbnail.extension.text" in runtime or "TextExtension" in runtime
    results.append(dict(fixture=filename, command="qlmanage -t -s 512", simplemd_thumbnail=simplemd,
                        apple_text_thumbnail=apple, png=(pngs / (filename + ".png")).exists()))

# Preview filenames are private in unified logs. Each request has a separate log interval.
failures = []
for filename in ["README.md", "math.md", "mermaid.md", "local-image.md", "fixture.mdx",
                 "hostile.md", "large.md", "empty.md", "non-utf8.md", "readable-image.md", "not-markdown.txt"]:
    fixture = fixtures / filename
    if filename == "readable-image.md":
        folder = Path.home() / "Library/Containers/com.jonathanreed.simplemd.preview/Data/Documents/m4-security-image"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "dot.png").write_bytes((fixtures / "dot.png").read_bytes())
        fixture = folder / filename
        fixture.write_text("# A readable local image\n\n![Readable red square](dot.png)\n\n![Missing sibling](missing.png)\n")
    time.sleep(1.1)
    started = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    before = {w["kCGWindowNumber"] for w in window_list()}
    with (root / (filename + "-preview.txt")).open("w") as output:
        process = subprocess.Popen(["qlmanage", "-p", str(fixture)], stdout=output, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 25
            candidates = []
            while time.monotonic() < deadline:
                candidates = [w for w in window_list() if w["kCGWindowNumber"] not in before
                              and w["kCGWindowOwnerName"] in ["qlmanage", "QuickLookUIService", "Quick Look"]
                              and w["kCGWindowBounds"]["Height"] > 100]
                if candidates or process.poll() is not None:
                    break
                time.sleep(0.2)
            time.sleep(3)
            assert len(candidates) == 1, (filename, candidates)
            if filename in ["README.md", "math.md", "local-image.md", "fixture.mdx"]:
                run(["screencapture", "-x", "-o", "-l", str(candidates[0]["kCGWindowNumber"]),
                     str(panels / (filename + ".png"))])
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    runtime = logs(started)
    (root / (filename + "-preview-runtime.txt")).write_text(runtime)
    simplemd = "Preview ready file=" in runtime
    if filename.endswith(".txt"):
        if simplemd:
            failures.append("SimpleMD claimed plain text")
    elif not simplemd:
        failures.append(filename + ": no SimpleMD preview receipt")
    if "Preview failed" in runtime:
        failures.append(filename + ": preview failed")
    if filename == "readable-image.md" and "images_embedded=1" not in runtime:
        failures.append(filename + ": no embedded raster receipt")
    results.append(dict(fixture=filename, simplemd_preview=simplemd, panel=True))
    (root / "results.json").write_text(json.dumps(results, indent=2) + "\n")
assert not main_processes(), main_processes()
print(json.dumps(results, indent=2))
assert not failures, failures
