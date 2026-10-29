# Release

Releases come from this repository. macOS signing stays on the owner's Mac. Windows and Linux build in Actions. Nothing publishes to winget or Homebrew automatically.

## One-time setup

- Install the Developer ID Application certificate for team `AJ9VWBRNZN` locally. Set `SIMPLEMD_SIGN_IDENTITY` to its full `Developer ID Application: ... (AJ9VWBRNZN)` name. Keep it out of CI.
- Store notarization credentials yourself with `xcrun notarytool store-credentials simplemd-notary --team-id AJ9VWBRNZN`. Enter the account and app-specific password at the prompts. Do not commit either.
- After SignPath Foundation approval, configure secrets `SIGNPATH_API_TOKEN` and `SIGNPATH_ORGANIZATION_ID`, and repository variables `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG`, and `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`. The artifact configuration must sign the NSIS installer and its embedded executables. Missing configuration produces unsigned artifacts. A configured signing failure stops that build.
- Create a personal `homebrew-tap` repository when ready. Manifest generation does not write to that repository.

## Each release

1. Finish the plan's runtime, fidelity, performance, Quick Look and Windows hardware checks. Packaging tests do not replace these checks.
2. Set `app/package.json` to the intended stable version and commit. The tag and script version must match it. Use a clean checkout with Bun, Node 24 and a native Rust toolchain.
3. Run `bun run test:release`, `bun run typecheck`, then `bun run release:mac --version X.Y.Z --dry-run`. Dry run validates config without building, signing or accessing notarization credentials.
4. For a CI rehearsal, run the Release workflow with `workflow_dispatch` on the candidate branch. It uploads Windows/Linux artifacts and checksums and never creates a release. A new workflow must first exist on the default branch before GitHub permits dispatch.
5. When ready, the owner creates and pushes `vX.Y.Z`. Release CI builds Windows x64 NSIS and Linux x64 AppImage/DEB, optionally signs Windows, hashes final bytes, and creates a draft release with generated notes. Linux runtime qualification remains after v1.0.
6. On the Mac, run `bun run release:mac --version X.Y.Z` under low host load. It builds for the current architecture, signs app and Quick Look extensions, notarizes with `simplemd-notary`, staples, verifies, and writes DMG, ZIP, update metadata and SHA-256 checksums under `app/release/mac-X.Y.Z-ARCH/`. It refuses an existing output directory. The printed `gh release upload` command uploads to the draft; the script never uploads itself.
7. For both Mac architectures, repeat on a matching native host. Merge their `latest-mac.yml` files with `bun app/build/release-metadata.mjs --merge-mac ARM_DIR INTEL_DIR OUTPUT_DIR`. Upload both sets of DMG/ZIP/blockmap files and architecture checksums, but upload only the merged `latest-mac.yml`. Never overwrite one architecture's feed with the other. Mac checksums cover the archives, so merging the feed does not invalidate them.
8. Verify checksums, install and update on clean signed Mac and Windows builds, inspect the draft notes and assets, then publish the draft yourself. Test the disabled update setting, daily check limit, background download, restart confirmation and unsaved-edit cancellation. Unsigned Mac and development builds skip updates. AppImage supports updates; DEB uses the package manager.
9. After publication, run `bun packaging/generate.mjs vX.Y.Z OUTPUT_DIR`. It reads this repository's release asset URLs and SHA-256 digests through `gh api`, and writes three winget manifests plus `homebrew/simplemd.rb`. Both Mac DMGs and the Windows installer must exist. Inspect the files, validate with winget and Homebrew on their hosts, then submit to winget and copy the cask to the personal tap yourself.

Automatic checks happen at most daily across restarts. Settings writes `auto-update = false` to disable automatic checks and downloads; Check for Updates remains available. A downloaded update installs only through Restart to Install Update and its confirmation. Normal quit never installs it.

Published assets use `SimpleMD-X.Y.Z-OS-ARCH.ext`. Keep ZIPs and `latest*.yml` beside the installers for electron-updater. The release workflow refreshes installer hashes after SignPath signing. SignPath secrets and macOS identities never appear in release metadata.
