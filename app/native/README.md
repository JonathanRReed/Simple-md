# simplemd-peek

Rust helper for SimpleMD's file-manager preview shortcut. It runs as a child of Electron and exchanges newline-delimited JSON over stdio. Closing stdin or sending `quit` stops it.

## Build and check

```sh
cargo test
cargo clippy -- -D warnings
cargo check --target x86_64-pc-windows-msvc
cargo build --release
```

From the project root, `bun run build:native` builds the current host target and copies the helper into the development lookup location. Packaging includes that host's binary.

## Protocol

Helper output:

| Event | Meaning |
| --- | --- |
| `{"event":"ready","platform":"macos","permission":"granted"}` | Accessibility state at startup. Permission can also be `missing` or `unsupported`. Windows and Linux report their platform names. |
| `{"event":"permission","state":"granted"}` | macOS Accessibility trust changed. |
| `{"event":"selection","paths":["/a.md"]}` | Speculative pre-render candidate. This never authorizes a later Space interception. |
| `{"event":"peek","requestId":1,"app":"com.apple.finder","paths":["/a.md"]}` | A Space request with a current selected-file snapshot. |
| `{"event":"error","message":"..."}` | Helper or platform failure. |

App input:

| Command | Meaning |
| --- | --- |
| `{"cmd":"complete-peek","requestId":1}` | Finish the matching request. |
| `{"cmd":"validate-peek","requestId":1}` | Recheck the original selection and request lifetime before opening. Replies with `{"event":"peek-valid","requestId":1,"valid":true}` or `false`. |
| `{"cmd":"replay-space","requestId":1}` | Consume the matching pending request and return Space only if its original context still matches. |
| `{"cmd":"set-enabled","enabled":false}` | Stop intercepting new keys. |
| `{"cmd":"quit"}` | Exit. |

Requests expire after two seconds. An old reply cannot consume a newer request. Duplicate replies have no effect. A second press passes through while a request is pending. Replayed events carry a tag so the helper does not intercept them again. Invalid commands produce an error and do not change state.

## macOS

The event tap handles a bare, non-repeating Space only while Finder is frontmost. Modified Space, typing in a text field, unsupported selection views, ambiguous selection, failed AX queries, and non-Markdown selections pass through.

The callback reads the focused content container's `AXSelectedChildren` or `AXSelectedRows` and the selected item's `AXURL`. It accepts one Markdown selection. It does not use the polling cache, execute AppleScript, read a document, or wait for Electron. Each AX request has a short messaging timeout, and the selection walk has time and node limits. These are fail-open limits, not a hard real-time guarantee from macOS.

A worker resolves Finder's file-reference URL to a path. It checks that the file is regular and the selection still matches before sending the peek. The background watcher reads selection separately for pre-rendering. Only Accessibility permission is needed for this native path. The app's separate global-shortcut fallback may ask for Finder Automation permission.

macOS attributes Accessibility access to the responsible application. Development shells, Electron, and packaged builds can have different identities. Rebuilding an ad hoc signed helper may invalidate remembered permission. The helper does not grant or reset permissions.

Supported Markdown extensions are `.md`, `.markdown`, `.mdown`, `.mkd`, and `.mdx`, case-insensitive. `.txt` uses the normal file-manager preview.

## Windows

The helper reports `unsupported` and intercepts no keys. Use Open With or the app's global shortcut. The global shortcut looks up the selected file in the foreground Explorer window.

## Linux

The helper reports `unsupported` and intercepts no keys. Use Open With, drag and drop, or SimpleMD's Open command. See [Linux integration](../integrations/linux/README.md) for desktop entries. There is no universal selected-file or bare-Space hook across Linux file managers and Wayland compositors.

## Diagnostics and proof limits

```sh
./target/release/simplemd-peek --probe
./target/release/simplemd-peek --probe --delay 3
SMD_TRACE=1 ./target/release/simplemd-peek
```

The probe reports the frontmost application, text-input focus, Accessibility trust, and resolved Markdown paths when Finder exposes a supported selection. Trace logs record Space events seen by the tap. They do not log other keys.

Current tests cover protocol encoding, modifier and text-role filters, file-reference resolution with reserved and non-ASCII filenames, directory rejection, request expiry, duplicate replies, and stale acknowledgements. A successful probe proves selection lookup. It does not prove physical keyboard delivery, app focus, or packaged permission behavior. Those require the live Finder checklist recorded with the completion evidence.
