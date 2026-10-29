import { createHash } from "node:crypto";
import { createReadStream, readFileSync, readdirSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

export async function digest(file, algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest(algorithm === "sha512" ? "base64" : "hex");
}
// Signing or stapling changes the bytes electron-builder originally hashed.
export async function refreshUpdateMetadata(directory) {
  for (const name of readdirSync(directory).filter(name => /^latest.*\.yml$/.test(name))) {
    const file = path.join(directory, name);
    const metadata = YAML.parse(readFileSync(file, "utf8"));
    for (const entry of metadata.files) {
      const asset = path.join(directory, path.basename(entry.url));
      entry.sha512 = await digest(asset, "sha512");
      entry.size = statSync(asset).size;
    }
    if (metadata.path) metadata.sha512 = await digest(path.join(directory, path.basename(metadata.path)), "sha512");
    writeFileSync(file, YAML.stringify(metadata));
  }
}
export async function writeChecksums(directory, name = "SHA256SUMS", { includeMetadata = true } = {}) {
  const assets = readdirSync(directory).filter(file => /\.(dmg|zip|exe|AppImage|deb|yml|blockmap)$/.test(file) && (includeMetadata || !file.endsWith(".yml"))).sort();
  if (!assets.length) throw new Error("No release artifacts found.");
  const lines = [];
  for (const file of assets) lines.push(`${await digest(path.join(directory, file), "sha256")}  ${file}`);
  writeFileSync(path.join(directory, name), lines.join("\n") + "\n");
}
export function mergeMacMetadata(directories, output) {
  const manifests = directories.map(directory => YAML.parse(readFileSync(path.join(directory, "latest-mac.yml"), "utf8")));
  const first = manifests[0];
  if (manifests.length !== 2 || !first?.version || manifests.some(manifest => manifest.version !== first.version)) throw new Error("Merge two Mac feeds with the same version.");
  const files = manifests.flatMap(manifest => manifest.files);
  if (new Set(files.map(file => file.url)).size !== files.length || !files.some(file => file.url.includes("arm64") && file.url.endsWith(".zip")) || !files.some(file => file.url.includes("x64") && file.url.endsWith(".zip"))) throw new Error("Expected distinct arm64 and x64 ZIP assets.");
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, "latest-mac.yml"), YAML.stringify({ ...first, files }), { flag: "wx" });
}
if (import.meta.main) {
  if (process.argv[2] === "--merge-mac") {
    if (process.argv.length !== 6) throw new Error("Usage: bun release-metadata.mjs --merge-mac ARM_DIR INTEL_DIR OUTPUT_DIR");
    mergeMacMetadata(process.argv.slice(3, 5), process.argv[5]);
  } else {
    await refreshUpdateMetadata(process.argv[2]);
    await writeChecksums(process.argv[2]);
  }
}
