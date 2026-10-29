# simplemd-helper

Rust helper for preserving macOS metadata during atomic saves. Electron invokes it for an existing file before writing the replacement data:

```sh
simplemd-helper --copy-metadata <source> <target>
```

The helper copies ACLs and extended attributes, including Finder tags, without following source or target symlinks. The caller owns the empty target file and writes its data afterwards. Successful copies exit zero. Invalid arguments or copy failures exit nonzero with an error on stderr. Other platforms report that metadata copying is unsupported; their saves use the normal TypeScript path.

The helper has no keyboard hook, selection lookup, permission prompt, background loop, or stdio request protocol. Quick Look extensions live separately in `quicklook/`. The CLI and Windows preview handler are later milestones.

## Build and check

```sh
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo clippy --locked --all-targets --target x86_64-pc-windows-msvc -- -D warnings
cargo build --locked --release
```

From the project root, `bun run build:native` builds the current host target and copies `simplemd-helper` into the development lookup location. Packaging includes that host's helper binary. Windows packages use `simplemd-helper.exe`.

The separate `perf-memory` binary measures physical footprint on macOS and private working set on Windows. The performance script builds it into its own receipt directory. It is not packaged with the app.

The full smoke suite checks byte preservation, extended attributes, Finder tags, ACLs, and file permissions through real macOS saves. Build the helper before running those checks.
