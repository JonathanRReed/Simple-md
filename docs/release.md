# Release

Releases come from this repository. macOS signing stays on the owner's Mac. Windows and Linux build in Actions. Nothing publishes to winget or Homebrew automatically.

## One-time setup

- Install the Developer ID Application certificate for team `AJ9VWBRNZN` locally. Set `SIMPLEMD_SIGN_IDENTITY` to its full `Developer ID Application: ... (AJ9VWBRNZN)` name. Keep it out of CI.
- Store notarization credentials yourself with `xcrun notarytool store-credentials simplemd-notary --team-id AJ9VWBRNZN`. Enter the account and app-specific password at the prompts. Do not commit either. To reuse an existing profile for the same team, set `SIMPLEMD_NOTARY_PROFILE` to its name.
- After SignPath Foundation approval, configure secrets `SIGNPATH_API_TOKEN` and `SIGNPATH_ORGANIZATION_ID`, and repository variables `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG`, and `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`. Configure the artifact to sign the NSIS installer and approved SimpleMD-owned executables, including the CLI, helper and preview DLL. Preserve upstream Electron signatures; do not re-sign upstream binaries with the project certificate. Configure manual approval and allow time to approve the request before the 40-minute build timeout. Missing or partial signing configuration fails the Windows job. To choose unsigned output explicitly, set repository variable `ALLOW_UNSIGNED_WINDOWS_RELEASE=true`, or select `allow_unsigned_windows` for a manual rehearsal. This bypasses SignPath even if credentials exist. Leave it unset or false for signed releases. See the Code signing policy below.
- Create a personal `homebrew-tap` repository when ready. Manifest generation does not write to that repository.

## Each release

1. Finish the plan's runtime, fidelity, performance, Quick Look and Windows hardware checks. Packaging tests do not replace these checks.
2. Set `app/package.json` to the intended stable version and commit. The tag and script version must match it. Use a clean checkout with Bun, Node 24 and a native Rust toolchain.
3. Require a successful Desktop checks workflow push run for the exact candidate commit. Release CI fails before building if none exists; rerun Release after desktop checks pass. The gate includes lint, typecheck, unit tests, the fidelity corpus and the Windows installer lane. It does not qualify owner runtime or performance gates. Run `bun run test:release`, `bun run typecheck`, then `bun run release:mac --version X.Y.Z --dry-run`. Dry run validates config without building, signing or accessing notarization credentials.
4. For a CI rehearsal, run the Release workflow with `workflow_dispatch` on the candidate branch. It uploads Windows/Linux artifacts and checksums and never creates a release. A new workflow must first exist on the default branch before GitHub permits dispatch.
5. When ready, the owner creates and pushes `vX.Y.Z`. Release CI builds Windows x64 NSIS and Linux x64 AppImage/DEB, signs Windows unless unsigned output was explicitly enabled, verifies the returned installer's Authenticode status is Valid, hashes those final bytes, and creates a draft release with generated notes. Linux runtime qualification remains after v1.0.
6. On the Mac, run `bun run release:mac --version X.Y.Z` under low host load. It builds for the current architecture, signs app and Quick Look extensions, notarizes with `simplemd-notary`, staples, verifies, and writes DMG, ZIP, update metadata and SHA-256 checksums under `app/release/mac-X.Y.Z-ARCH/`. It refuses an existing output directory. The printed `gh release upload` command uploads to the draft; the script never uploads itself.
7. Mac releases are Apple Silicon only. Intel Macs are not supported.
8. Verify checksums, install and update on clean signed Mac and Windows builds, inspect the draft notes and assets, then publish the draft yourself. Test the disabled update setting, daily check limit, background download, restart confirmation and unsaved-edit cancellation. Unsigned Mac, development and local packages without `app-update.yml` skip updates. AppImage supports updates; DEB uses the package manager.
9. After publication, run `bun packaging/generate.mjs vX.Y.Z OUTPUT_DIR`. It reads this repository's release asset URLs and SHA-256 digests through `gh api`, and writes three winget manifests plus `homebrew/simplemd.rb`. The Apple Silicon DMG and the Windows installer must exist. Inspect the files, validate with winget and Homebrew on their hosts, then submit to winget and copy the cask to the personal tap yourself.

Only packaged builds containing `app-update.yml` qualify for automatic updates. This excludes locally signed `pack` builds without release metadata. Automatic checks happen at most daily across restarts. Settings writes `auto-update = false` to disable automatic checks and downloads; Check for Updates remains available. A downloaded update installs only through Restart to Install Update and its confirmation. Normal quit never installs it. Check for Updates reports check failures and whether a download is ready. Restart to Install Update reports when nothing is ready; update errors also go to the main-process log. There is no persistent readiness or error indicator yet.

Published assets use `SimpleMD-X.Y.Z-OS-ARCH.ext`. Keep ZIPs and `latest*.yml` beside the installers for electron-updater. The release workflow refreshes installer hashes after SignPath signing. SignPath secrets and macOS identities never appear in release metadata.

## Code signing policy

SignPath Foundation approval and account configuration remain owner steps. The intended service is free code signing provided by [SignPath.io](https://signpath.io), with a certificate from [SignPath Foundation](https://signpath.org). This does not claim that approval or a signed Windows release exists.

Jonathan R. Reed maintains this repository, reviews contributed changes and approves release signing. The owner must configure those roles in SignPath and require manual approval for each release, following the [Foundation conditions](https://signpath.org/terms). The artifact configuration must restrict signing to approved SimpleMD-owned artifacts, enforce product/version metadata and preserve upstream signatures.

The workflow verifies the returned installer's Authenticode signature before replacing the unsigned installer and refreshing hashes. A Valid signature does not pin the expected publisher. The actual certificate subject is still unknown; configuring updater publisher verification remains an owner release gate. Do not infer the subject from a service name.

The app does not upload document contents. Its default remote-image setting can contact image hosts referenced by a document; set `remote-images = false` to stop those loads. Automatic update checks contact GitHub at most daily and can be disabled with `auto-update = false`. Manual update checks and external links use the services you request. See [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). Quick Look and Explorer previews make no document resource requests to the network.

Release tooling accepts stable `X.Y.Z` versions, including stable 0.x versions. It rejects prerelease suffixes, and the updater ignores prereleases. The plan's separate preview-release channel remains an owner decision. Homebrew and winget files are templates until generated, validated and published by the owner.

Historical qualification reports under `docs/reports/` and native preview evidence folders record their original candidates. Some raw receipts and worktree paths exist only in local archives. The [Quick Look archive record](../app/native/quicklook/SPIKE.md) identifies its retained reports and archive manifest. Those reports do not qualify a new release or reproduce every check from a public clone.
