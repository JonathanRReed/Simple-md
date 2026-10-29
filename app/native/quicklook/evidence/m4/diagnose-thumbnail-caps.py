from pathlib import Path
import datetime, subprocess, sys
root = Path(sys.argv[1])
start = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
fixtures = {
    "large.mdx": b"# Large thumbnail cap\n" + b"A bounded title card.\n" * 10000,
    "empty.mdx": b"",
    "non-utf8.mdx": b"# Invalid thumbnail bytes\nBefore \xff\xfe after.\n"
}
for name, data in fixtures.items():
    file = root / name
    file.write_bytes(data)
    result = subprocess.run(["qlmanage", "-t", "-x", "-s", "512", "-o", str(root), str(file)],
                            capture_output=True, text=True, check=True, timeout=30)
    (root / (name + ".txt")).write_text(result.stdout + result.stderr)
result = subprocess.run(["/usr/bin/log", "show", "--start", start, "--style", "compact", "--info", "--debug",
                         "--predicate", 'subsystem == "com.jonathanreed.simplemd.quicklook"'], capture_output=True, text=True, check=True)
(root / "runtime.txt").write_text(result.stdout + result.stderr)
print(result.stdout)
for name in fixtures:
    assert "Thumbnail drawn file=" + name + " " in result.stdout
assert "Thumbnail preparing file=large.mdx bytes=65536 " in result.stdout
assert "Thumbnail preparing file=empty.mdx bytes=0 " in result.stdout
