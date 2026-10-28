# CLI, IPC and URL scheme

Milestone 5. Security review required before merge.

## Shape

A small Rust `simplemd` executable. On a warm start it connects to the running app, sends one framed request, and exits after acknowledgment. It never starts a second Electron process on the warm path. Electron's single-instance lock still settles cold-start races. Only the primary instance opens the IPC server, after it holds the lock.

## Transport

- macOS and Linux: a Unix socket in a per-user runtime directory with mode `0700`, using a short path.
- Windows: `\\.\pipe\simplemd-<user-SID>` with an explicit current-user ACL. A SID in the name alone is not authorization.
- Every request carries a protocol version and request ID. Frames are capped at 1 MiB, except for stdin payloads (see below). A connection secret lives in the protected runtime directory. No TCP listener.
- Cold path: try to connect. If that fails, launch the app through the platform mechanism and retry for a bounded window. Report failure on stderr. Never delete a socket just because one connection timed out. Check ownership and liveness before cleaning up a stale endpoint.

## Commands

| Command | Contract |
| --- | --- |
| `simplemd file.md` | Resolve against the CLI's cwd and send an absolute path. Exit 0 only after the app accepts the open. Support `--` before paths that start with `-`. Explicit CLI opens accept any text file, not only Markdown extensions, so git's `COMMIT_EDITMSG` works. |
| `simplemd file.md:42`, `simplemd file.md#heading` | Treat `:N` as a line number only when the literal path does not exist. `#slug` uses the same slugger as the renderer. |
| `simplemd -` | Read stdin as UTF-8, capped at 10 MiB. Send the bytes over IPC, not argv. Open an unsaved document with no disk location. `--stdin-name` sets the display name and Markdown or MDX mode. |
| `simplemd --wait file.md` | Hold a waiter token on the document ID. Saving does not end the wait. Closing the tab, or a confirmed discard, does. A cancelled close keeps waiting. The app staying in the tray does not block completion. Save As keeps the token. Several callers can wait on one document. App or IPC failure exits nonzero. |
| `simplemd --wait -` | Like the above, for an unsaved stdin document. Saving needs an explicit destination. |
| `simplemd export file.md --format html -o out.html` | Shares the export pipeline without a visible editor. Atomic output write. Explicit overwrite policy. Logs go to stderr. |
| `simplemd export file.md --format pdf -o out.pdf` | Uses Electron's print pipeline in a hidden export job that never swaps the user's active document. Exits once the PDF is written. |

Exit codes: 0 success, 1 operational failure, 2 usage error. A Ctrl-C in the waiting terminal is not document completion.

`$EDITOR='simplemd --wait'` is the supported editor integration.

## Install

- macOS: a menu item installs a symlink to the bundled binary, the same way VS Code installs `code`.
- Windows: the installer adds it to the user PATH.
- Linux: the package installs it on PATH.

## URL scheme

- `simplemd://open?path=<absolute>&line=<n>` or `&heading=<slug>`. `open` is the only action. No export, write, wait or config actions.
- The path must be absolute, exist, and be a supported file type. Validate it after decoding.
- Windows registers the handler as `"SimpleMD.exe" -- "%1"` so a URL cannot inject arguments.
- Raycast and Alfred get documented script commands that call the CLI or URL scheme. No extension packages.

Source: `.audit/research/e-os-integration.md`, "CLI architecture" (local only).
