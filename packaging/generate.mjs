import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releaseVersion, repository } from "../app/build/release-config.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
export function generateManifests(release) {
  const version = releaseVersion(release.tag_name?.replace(/^v/, ""));
  if (release.draft || release.prerelease) throw new Error("Use a published stable release.");
  const values = { VERSION: version };
  for (const [key, os, arch, extension] of [["WINDOWS", "win", "x64", "exe"], ["MAC_ARM64", "mac", "arm64", "dmg"], ["MAC_X64", "mac", "x64", "dmg"]]) {
    const name = `SimpleMD-${version}-${os}-${arch}.${extension}`;
    const asset = release.assets?.find(asset => asset.name === name);
    const url = `https://github.com/${repository}/releases/download/v${version}/${name}`;
    if (asset?.browser_download_url !== url || !/^sha256:[a-f0-9]{64}$/i.test(asset?.digest ?? "")) throw new Error(`Missing trusted URL or SHA-256 digest for ${name}.`);
    values[`${key}_URL`] = url;
    values[`${key}_SHA256`] = asset.digest.slice(7);
  }
  const files = {};
  for (const name of ["winget/SimpleMD.yaml", "winget/SimpleMD.installer.yaml", "winget/SimpleMD.locale.en-US.yaml", "homebrew/simplemd.rb"]) {
    const template = readFileSync(path.join(directory, name), "utf8");
    files[name] = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
      if (!(key in values)) throw new Error(`Unknown template key ${key}.`);
      return values[key];
    });
  }
  return files;
}
if (import.meta.main) {
  const [tag, output] = process.argv.slice(2);
  releaseVersion(tag?.replace(/^v/, ""));
  if (!tag?.startsWith("v") || !output || process.argv.length !== 4) throw new Error("Usage: bun packaging/generate.mjs vX.Y.Z <output-directory>");
  const release = JSON.parse(execFileSync("gh", ["api", `repos/${repository}/releases/tags/${tag}`], { encoding: "utf8" }));
  const files = generateManifests(release);
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(output, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, { flag: "wx" });
    console.log(file);
  }
}
