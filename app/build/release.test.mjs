import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import { macReleasePlan } from "./release-mac.mjs";
import { feed, releaseConfig, releaseVersion } from "./release-config.mjs";
import { nativePlan, appDir } from "./native.mjs";
import { digest, refreshUpdateMetadata, writeChecksums } from "./release-metadata.mjs";
import { generateManifests } from "../../packaging/generate.mjs";

const preflight = { version: "1.0.0", expected: "1.0.0", dirty: "", platform: "darwin", arch: "arm64" };
test("mac dry-run preflight refuses dirty trees, version mismatch, wrong host and identity", () => {
  for (const [patch, message] of [[{ dirty: "?? new.txt" }, "clean"], [{ expected: "2.0.0" }, "mismatch"],
    [{ platform: "linux" }, "Mac"], [{ arch: "ia32" }, "Mac"], [{ identity: "Developer ID Application: Other (OTHERTEAM)" }, "AJ9VWBRNZN"]]) {
    expect(() => macReleasePlan({ ...preflight, ...patch })).toThrow(message);
  }
  for (const version of [undefined, "v1.0.0", "1.0", "1.0.0-beta.1", "01.0.0", "1.0.0;whoami"]) expect(() => releaseVersion(version)).toThrow();
  const plan = macReleasePlan(preflight);
  expect(plan.keychainProfile).toBe("simplemd-notary");
  expect(plan.steps.join("\n")).toContain("Staple app");
  expect(plan.steps.join("\n")).toContain("latest-mac.yml");
  expect(plan.upload).toContain("gh release upload v1.0.0 --repo JonathanRReed/Simple-md");
});
test("electron-builder accepts the release feed, resources and artifact names", async () => {
  const { getConfig, validateConfiguration } = await import("app-builder-lib/out/util/config/config.js");
  const { DebugLogger } = await import("builder-util");
  const plan = nativePlan("aarch64-apple-darwin", "darwin", "arm64");
  const config = await getConfig(appDir, null, { ...releaseConfig(plan, "release/test"),
    forceCodeSigning: true, mac: { identity: "Owner (AJ9VWBRNZN)", notarize: false }, dmg: { sign: true } });
  await validateConfiguration(config, new DebugLogger(false));
  expect(config.publish).toEqual([feed]);
  expect(config.mac.target).toEqual(["dmg", "zip"]);
  expect(config.extraResources).toContainEqual({ from: "../LICENSE", to: "LICENSE" });
  expect(config.extraResources).toContainEqual({ from: plan.cliBinary, to: "native/simplemd" });
  expect(config.artifactName).toBe("SimpleMD-${version}-${os}-${arch}.${ext}");
});
test("release workflow requires desktop qualification and explicit signing intent", () => {
  const workflow = YAML.parse(readFileSync(path.join(appDir, "../.github/workflows/release.yml"), "utf8"));
  expect(workflow.on.push.tags).toEqual(["v*"]);
  expect(workflow.on).toHaveProperty("workflow_dispatch");
  expect(workflow.jobs.draft.if).toContain("github.event_name == 'push'");
  const steps = workflow.jobs.build.steps;
  expect(workflow.jobs.build.needs).toBe("qualify");
  const qualify = workflow.jobs.qualify.steps[0];
  expect(qualify.env.CANDIDATE_SHA).toBe("${{ github.sha }}");
  expect(qualify.run).toContain("actions/workflows/desktop.yml/runs?head_sha=$CANDIDATE_SHA&status=success&event=push");
  expect(qualify.run).toContain('if [ "$count" -eq 0 ]');
  expect(qualify.run).toContain("exit 1");
  expect(workflow.on.workflow_dispatch.inputs.allow_unsigned_windows.default).toBe(false);
  const validate = steps.find(step => step.name === "Validate Windows signing configuration");
  for (const name of ["SIGNPATH_API_TOKEN", "SIGNPATH_ORGANIZATION_ID", "SIGNPATH_PROJECT_SLUG", "SIGNPATH_SIGNING_POLICY_SLUG", "SIGNPATH_ARTIFACT_CONFIGURATION_SLUG"]) expect(validate.run).toContain(name);
  expect(validate.run).toContain("throw");
  expect(steps.find(step => step.name === "Sign Windows installer").if).toContain("env.ALLOW_UNSIGNED_WINDOWS_RELEASE != 'true'");
  expect(steps.find(step => step.name === "Report unsigned fallback").if).toContain("env.ALLOW_UNSIGNED_WINDOWS_RELEASE == 'true'");
  const verify = steps.find(step => step.name === "Verify signed Windows installer");
  expect(verify.if).toBe(steps.find(step => step.name === "Sign Windows installer").if);
  expect(verify.run).toContain("Get-AuthenticodeSignature");
  expect(verify.run).toContain("$signature.Status -ne 'Valid'");
  expect(verify.run).toContain("$signed.Count -ne 1");
  expect(steps.find(step => step.name === "Sign Windows installer").with["output-artifact-directory"]).toBe("signed-installer");
  expect(steps.indexOf(verify)).toBeGreaterThan(steps.findIndex(step => step.name === "Sign Windows installer"));
  expect(steps.findIndex(step => step.name === "Hash final bytes and refresh update metadata")).toBeGreaterThan(steps.indexOf(verify));
  expect(JSON.stringify(workflow)).not.toMatch(/APPLE_|CSC_LINK|notarytool/);
});
test("checksums and update metadata describe final signed or stapled bytes", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "smd-release-"));
  try {
    writeFileSync(path.join(dir, "SimpleMD.exe"), "signed installer");
    writeFileSync(path.join(dir, "latest.yml"), YAML.stringify({ version: "1.0.0", path: "SimpleMD.exe", sha512: "old", files: [{ url: "SimpleMD.exe", sha512: "old", size: 1 }] }));
    await refreshUpdateMetadata(dir);
    await writeChecksums(dir);
    const metadata = YAML.parse(readFileSync(path.join(dir, "latest.yml"), "utf8"));
    expect(metadata.sha512).toBe(await digest(path.join(dir, "SimpleMD.exe"), "sha512"));
    expect(metadata.files[0]).toEqual({ url: "SimpleMD.exe", sha512: metadata.sha512, size: 16 });
    expect(readFileSync(path.join(dir, "SHA256SUMS"), "utf8")).toContain(`${await digest(path.join(dir, "SimpleMD.exe"), "sha256")}  SimpleMD.exe`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
const fakeRelease = () => ({ tag_name: "v1.2.3", draft: false, prerelease: false,
  assets: ["win-x64.exe", "mac-arm64.dmg"].map(suffix => ({
    name: `SimpleMD-1.2.3-${suffix}`, digest: `sha256:${"ab".repeat(32)}`,
    browser_download_url: `https://github.com/JonathanRReed/Simple-md/releases/download/v1.2.3/SimpleMD-1.2.3-${suffix}`,
  })) });
test("generates winget and Homebrew from a fake release without publishing", () => {
  const files = generateManifests(fakeRelease());
  expect(Object.keys(files)).toHaveLength(4);
  const installer = YAML.parse(files["winget/SimpleMD.installer.yaml"]);
  expect(installer.PackageVersion).toBe("1.2.3");
  expect(installer.Installers[0].InstallerSha256).toBe("ab".repeat(32));
  expect(files["homebrew/simplemd.rb"]).toContain('binary "#{appdir}/SimpleMD.app/Contents/Resources/native/simplemd"');
  expect(files["homebrew/simplemd.rb"]).toContain("depends_on arch: :arm64");
  expect(Object.values(files).join("\n")).not.toContain("{{");
  for (const patch of [{ draft: true }, { prerelease: true }, { assets: [] }, { tag_name: "v1.2.3\nmalicious" }]) expect(() => generateManifests({ ...fakeRelease(), ...patch })).toThrow();
  const release = fakeRelease(); release.assets[0].browser_download_url = "https://example.com/app.exe";
  expect(() => generateManifests(release)).toThrow("trusted");
  release.assets[0].browser_download_url = fakeRelease().assets[0].browser_download_url;
  release.assets[0].digest = "sha256:nope";
  expect(() => generateManifests(release)).toThrow("SHA-256");
});

test("the notary keychain profile can be overridden", () => {
  const base = { version: "1.0.0", expected: "1.0.0", dirty: "", platform: "darwin", arch: "arm64" };
  expect(macReleasePlan(base).keychainProfile).toBe("simplemd-notary");
  expect(macReleasePlan({ ...base, keychainProfile: "jrbar-notary" }).keychainProfile).toBe("jrbar-notary");
});
