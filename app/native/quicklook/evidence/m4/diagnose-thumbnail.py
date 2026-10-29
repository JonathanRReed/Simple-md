from pathlib import Path
import datetime, subprocess, sys
root = Path(sys.argv[1])
start = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
for name, content_type in [("default.md", None), ("forced.md", "net.daringfireball.markdown"),
                           ("public.markdown", "public.markdown"), ("custom.mdx", None)]:
    fixture = root / name
    fixture.write_text("# Thumbnail routing\n\nOne title card.\n")
    command = ["qlmanage", "-t", "-x", "-s", "512", "-o", str(root)]
    if content_type:
        command += ["-c", content_type]
    result = subprocess.run(command + [str(fixture)], capture_output=True, text=True, timeout=30)
    (root / (name + ".txt")).write_text(result.stdout + result.stderr)
result = subprocess.run(["/usr/bin/log", "show", "--start", start, "--style", "compact", "--info", "--debug",
                         "--predicate", 'subsystem == "com.jonathanreed.simplemd.quicklook"'], capture_output=True, text=True)
(root / "runtime.txt").write_text(result.stdout + result.stderr)
print(result.stdout)
