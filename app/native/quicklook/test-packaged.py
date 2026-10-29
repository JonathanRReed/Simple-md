"""Exercise one registered package. The calling shell owns registration and cleanup."""
from pathlib import Path
import base64
import datetime
import hashlib
import json
import re
import struct
import subprocess
import sys
import time

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
(fixtures / "dot.png").write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="))
(fixtures / "fixture.mdx").write_text('---\ntitle: MDX\n---\nimport Widget from "./widget.js"\n\n# An inert MDX page\n\n<Widget onClick={() => alert("never")} />\n')
(fixtures / "large.md").write_bytes(b"# A bounded large file\n" + b"Only the first four megabytes appear.\n" * 125000 + b"TAIL MUST NOT APPEAR\n")
(fixtures / "empty.md").write_bytes(b"")
(fixtures / "non-utf8.md").write_bytes(b"# Invalid bytes\nBefore \xff\xfe after.\n")
(fixtures / "not-markdown.txt").write_text("Plain text stays with the system provider.\n")
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
                 "large.md", "empty.md", "non-utf8.md", "not-markdown.txt"]:
    fixture = fixtures / filename
    before = {w["kCGWindowNumber"] for w in window_list()}
    with (root / (filename + "-preview.txt")).open("w") as output:
        launched = time.time()
        process = subprocess.Popen(["qlmanage", "-p", str(fixture)], stdout=output, stderr=subprocess.STDOUT)
        try:
            time.sleep(4)
            candidates = [w for w in window_list() if w["kCGWindowNumber"] not in before
                          and w["kCGWindowOwnerName"] in ["qlmanage", "QuickLookUIService", "Quick Look"]
                          and w["kCGWindowBounds"]["Height"] > 100]
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
    tick = time.perf_counter()
    thumbnail = run(["qlmanage", "-t", "-x", "-s", "512", "-o", str(pngs), str(fixture)])
    thumbnail_ms = (time.perf_counter() - tick) * 1000
    (root / (filename + "-thumbnail.txt")).write_text(thumbnail.stdout + thumbnail.stderr)
    image = pngs / (filename + ".png")
    assert image.exists(), filename
    dimensions = struct.unpack(">II", image.read_bytes()[16:24])
    assert max(dimensions) == 512, (filename, dimensions)
    results.append(dict(fixture=filename, preview_launch_epoch=launched,
                        capture_bound_ms=round(capture_ms, 3),
                        thumbnail_wall_ms=round(thumbnail_ms, 3), thumbnail_pixels=dimensions))
    (root / "timings.json").write_text(json.dumps(results, indent=2) + "\n")

runtime = run(["/usr/bin/log", "show", "--start", start, "--style", "compact", "--info", "--debug",
               "--predicate", 'subsystem == "com.jonathanreed.simplemd.quicklook" OR '
               '(process == "sandboxd" AND eventMessage CONTAINS "SimpleMDQL") OR '
               '(process == "secinitd" AND eventMessage CONTAINS "SimpleMDQL")'])
(root / "runtime.txt").write_text(runtime.stdout + runtime.stderr)
for result in results:
    name = re.escape(result["fixture"])
    preview = re.findall(r"Preview ready file=" + name + r" .*?elapsed_ms=([0-9.]+)", runtime.stdout)
    drawn = re.findall(r"Thumbnail drawn file=" + name + r" elapsed_ms=([0-9.]+)", runtime.stdout)
    if result["fixture"].endswith(".txt"):
        assert not preview and not drawn, result
    else:
        assert preview and drawn, result
        ready_line = next(line for line in runtime.stdout.splitlines() if "Preview ready file=" + result["fixture"] + " " in line)
        ready_date = " ".join(ready_line.split()[:2])
        ready_epoch = datetime.datetime.strptime(ready_date, "%Y-%m-%d %H:%M:%S.%f").timestamp()
        result["launch_to_reply_ms"] = round((ready_epoch - result["preview_launch_epoch"]) * 1000, 3)
        result["preview_provider_ms"] = float(preview[-1])
        result["thumbnail_provider_ms"] = float(drawn[-1])
    result["simplemd_preview"] = bool(preview)
    result["simplemd_thumbnail"] = bool(drawn)
assert "read_bytes=4194304 truncated=true" in runtime.stdout
assert re.search(r"Thumbnail preparing file=large.md bytes=65536 ", runtime.stdout)
assert re.search(r"Preview ready file=non-utf8.md .*invalid_utf8=true", runtime.stdout)
assert not main_processes(), main_processes()
(root / "timings.json").write_text(json.dumps(results, indent=2) + "\n")
(root / "main-app-closed.txt").write_text("No process executable ending /Contents/MacOS/SimpleMD before or after the complete fixture sequence.\n")
print(json.dumps(results, indent=2))
