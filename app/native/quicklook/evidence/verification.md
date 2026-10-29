# Verification receipt

- Subject: SimpleMDQLSpike universal bundle built from source-sha256.txt, extension UUID 52C01953-D4AF-4A47-8180-92B0E60ADF81, starting revision a98679b in t3/b8791dd9
- Acceptance target: Discover and render Markdown through the signed sandboxed preview extension without sandbox denials, claim MDX, exclude plain text, and remove the temporary registration
- Checked at: 2026-10-28T19:37:54-05:00
- Required layers: Package, Discovery, Sandbox, Rendered UI, MDX selection, Text selection, Cleanup

| Layer | Required claim | Exact receipt | Status |
| --- | --- | --- | --- |
| Package | CLT builds both architectures with Developer ID signing and strict verification | build.txt exit 0; signing-preview.txt; signing-host.txt; verify-installed.txt exit 0 | Verified |
| Discovery | Registered host exposes its extension to PlugInKit | registration-open.txt lists the embedded extension; registration-use.txt records its temporary selection | Verified |
| Sandbox | Extension launches without sandbox denials | runtime-excerpt.txt records successful sandbox initialization followed by two mach-lookup denials for PID 28379 | Failed |
| Rendered UI | Proxy and Finder Space render the fixture inside WKWebView | runtime-excerpt.txt records WebKit launch failures for PIDs 28379 and 29363; finder-md.png shows the fallback card | Failed |
| MDX selection | Declaring the MDX type makes the spike handle the fixture | mdx-declaration.txt shows the exported type; types-registered.txt and finder-mdx-ax.txt show FluxMarkdown handling the file | Failed |
| Text selection | Spike does not claim plain text | types-registered.txt; finder-txt-ax.txt; runtime-excerpt.txt has no text preparation call | Verified |
| Cleanup | No installed spike app or persistent registration remains | cleanup-validation.txt records absent app copies and containers, no PlugInKit matches, zero LaunchServices identifiers, no process, unchanged original provider list | Verified |

Explicit exclusions: Notarization, Xcode installation, system software installation, Electron packaging integration, and changes to existing installed apps.

Remaining risk: Intel runtime and minimum-target runtime were not exercised. Network entitlement requirements and MDX coexistence need separate experiments. Gatekeeper rejects this unnotarized Developer ID app as expected.
