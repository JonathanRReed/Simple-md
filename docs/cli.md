# Command line tool

`simplemd` opens documents in the running app through private local IPC. If the app is closed, the CLI launches it and retries for up to 15 seconds. Warm opens do not start another Electron process.

## Install

On macOS, choose SimpleMD > Install Command Line Tool. It creates `/usr/local/bin/simplemd` when that directory is writable. Otherwise it uses `~/.local/bin/simplemd` and tells you to add that directory to PATH. It never runs sudo or replaces an existing file or a different symlink. Install the app in Applications first. If you move it later, inspect the old link with `ls -l /usr/local/bin/simplemd` and `ls -l ~/.local/bin/simplemd`. Remove only a link that you confirm belongs to the old SimpleMD location, then run Install Command Line Tool again. Do not remove an unrelated file.

Check the installed folder is on PATH with `command -v simplemd`. For the fallback folder, add `export PATH="$HOME/.local/bin:$PATH"` to your shell startup file and open a new terminal. Raycast and Alfred may not inherit your shell PATH; use the installed CLI's absolute path in their scripts.

The Windows installer adds the bundled CLI directory to your user PATH. Open a new terminal after installation. DEB packages install `/usr/bin/simplemd`; the Electron executable is `simplemd-app`. An unpacked Linux app includes the CLI at `resources/native/simplemd`. For AppImage, extract the bundle to a stable directory before linking its CLI onto PATH, and register its desktop entry as described in [Linux integration](../app/integrations/linux/README.md).

The stable bundled path is `Contents/Resources/native/simplemd` on macOS and `resources/native/simplemd.exe` on Windows. Linux uses `resources/native/simplemd`.

For development, run `bun run build:native` first. Use `app/native/target/release/simplemd` directly or put a symlink in a temporary PATH directory. Testing does not require a system installation.

## Open a file

```sh
simplemd file.md
simplemd notes.mdx
simplemd a.md b.md c.mdx
simplemd new-file.md
simplemd COMMIT_EDITMSG
simplemd -- -starts-with-a-dash.md
simplemd --help
```

On Windows, CLI and URL opens reject UNC network-share and device paths. Use a local drive path. Windows release installers target x64 only.

The CLI resolves paths against the caller's working directory. Existing files must contain UTF-8 text. A missing file in an existing folder opens as an unsaved draft bound to that path. Nothing is written until Save. Its first save uses that path without a dialog and refuses to replace a file created in the meantime. Missing parent folders remain errors. Explicit CLI opens accept text files with any extension or no extension. Directories, devices, FIFOs and binary input are rejected. Existing tabs are focused. Every positional path opens in argument order, so shell globs work. The last accepted file is active. A failed path does not prevent later paths from opening, but the command exits with an error. New tabs or windows follow the `open-in` setting. Files open in Read. Use the mode control or Command/Control-E to edit. `COMMIT_EDITMSG`, files without an extension and `--wait` buffers open in Source.

## Open at a line or heading

```sh
simplemd file.md:42
simplemd a.md:42 'b.mdx#my-heading'
simplemd 'file.md#my-heading'
simplemd 'file.md#my-heading-1'
```

Each file has its own line or heading suffix. Line targets open editable in Source. Heading targets open in Read. Lines start at 1. The CLI treats a trailing `:N` as a line only if the literal filename does not exist. An existing filename containing `#` also opens literally. For an ambiguous filename, use its full existing path.

Heading arguments are GitHub slugs, using the renderer's `github-slugger` behavior. Duplicate headings receive suffixes such as `-1`. Pass the slug itself, not a heading title. An unknown slug returns code 1 and names the missing heading on stderr. Quote shell arguments that contain `#`, spaces or shell metacharacters.

## Read stdin

```sh
printf '# Draft\n' | simplemd -
printf '# Draft\n' | simplemd --stdin-name draft.mdx -
printf '# Draft\n' | simplemd --wait --stdin-name draft.md -
```

Stdin must be UTF-8 text and is capped at 10 MiB. The bytes travel over IPC, never argv. The app opens an unsaved document with no disk location. `--stdin-name` supplies its display name. A `.mdx` name selects inert MDX mode; other names use Markdown. The default is `stdin.md`. Saving requires choosing a destination. The suggestion keeps the display name’s extension and uses the folder of the document active when the draft was created, if available.

## Wait for completion

```sh
simplemd --wait file.md
simplemd --wait a.md b.mdx new-file.md
simplemd --wait -
```

With several files, the process waits for all of them. The process waits until each document's tab closes or the user confirms a discard that passes the close checks. Saving does not complete the wait. Save As and Rename or Move keep the token on the same document. A cancelled or refused close keeps waiting. Several terminals can wait on one document, including while it moves between windows. The app can stay resident in the tray after completion.

App or IPC failure returns a nonzero code. Ctrl-C returns code 1 and disconnects that caller. It does not close the document or count as document completion.

## Use as an editor

```sh
export EDITOR='simplemd --wait'
export GIT_EDITOR='simplemd --wait'
git commit
```

Git's `COMMIT_EDITMSG` opens despite having no Markdown extension. Save your message, then close its tab to let Git continue. Closing without saving leaves Git's original text on disk. Save As retains the waiter, but Git still reads its original `COMMIT_EDITMSG` path.

## Export

```sh
simplemd export file.md --format html -o out.html
simplemd export file.md --format pdf -o out.pdf
simplemd export file.md --format html -o out.html --force
```

The output must not exist unless you pass `--force`. Export refuses to replace its input. `--force` can replace a regular output file, but not a directory or symlink. The app writes a temporary file beside the destination, flushes it, then publishes the complete output atomically. Without `--force`, publication fails if another writer creates the destination first.

Both formats use the shared export pipeline. PDF uses Electron's print pipeline in a hidden window. Export does not open a visible tab or change the active document. HTML embeds permitted local images and fonts. Failed image candidates produce warnings and do not expose local file URLs in the HTML.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The app accepted the open, the waited document completed, or the export was written. |
| 1 | An operational failure, such as a missing parent folder, rejected text, IPC failure, output conflict or Ctrl-C. |
| 2 | Invalid arguments or options. |

Errors go to stderr and distinguish missing files, directories, binary or invalid UTF-8 files, and permission failures. `--help` writes usage to stdout.

## URL scheme

```text
simplemd://open?path=%2Fabsolute%2Ffile.md&line=42
simplemd://open?path=%2Fabsolute%2Ffile.md&heading=my-heading
```

Percent-encode the absolute path. `open` is the only action. The decoded path must exist, be a regular file, and have a supported Markdown, MDX or text extension. Unknown or duplicate parameters, relative paths, invalid lines and simultaneous line and heading parameters are rejected. URL opens cannot export, write, wait or change configuration. Windows registers `"SimpleMD.exe" -- "%1"`.

[Raycast](../app/integrations/raycast/README.md) and [Alfred](../app/integrations/alfred/README.md) use scripts that call the CLI. No extension packages are included.

## IPC and implementation

The CLI is a second binary in the existing native crate. It shares the Rust toolchain, lockfile and packaging build with `simplemd-helper`; the two executables have separate entry points and responsibilities.

On macOS, the socket lives at `<per-user-temp>/smd-<uid>/ipc.sock`. On Linux, it uses `$XDG_RUNTIME_DIR/smd-<uid>/ipc.sock` when XDG_RUNTIME_DIR is absolute, otherwise `~/.cache/simplemd-cli/smd-<uid>/ipc.sock`. The containing directory belongs to that user with mode 0700. The state file and socket use mode 0600. Isolated development profiles use a hashed suffix. Windows uses `\\.\pipe\simplemd-<user-SID>` with an explicit current-user DACL and rejects remote pipe clients. Its connection state lives in a protected directory under LocalAppData. A Rust broker provides the Windows ACL, and Electron owns the broker through stdio.

Each request carries version 1, a request ID and a random 256-bit connection secret. Frames have a four-byte big-endian byte length. JSON request and response frames are capped at 1 MiB. An authenticated stdin header declares the exact length of one following raw UTF-8 frame, capped at 10 MiB. Empty stdin needs no payload frame. Each connection carries one command. Multiple files use the version 1 `open-many` command, with a `files` array and one `wait` flag. Each target has `path`, optional `line` or `heading`, and `create: true`. Single-file `open` also accepts `create`; omitting it keeps the existing-file-only behavior. The URL scheme never enables creation. The server caps concurrent connections and initial read time.

Only Electron's primary instance starts the server. Unix stale cleanup requires a same-user socket, protected state, a dead recorded owner PID, and a refused connection. A timeout never authorizes deletion. The CLI never removes endpoints. There is no TCP listener and no new renderer access to files or IPC secrets.

`export-job.ts` owns hidden print windows, HTML/PDF generation and atomic output publication. Call `createExportJobs(here, getSettings)` with an immutable `{ path, name, text }` source. This is also the shared entry point for drag-out export. It does not read the active session.
