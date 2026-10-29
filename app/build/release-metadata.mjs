import { createHash } from "node:crypto";
import { createReadStream, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
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
if (import.meta.main) {
  await refreshUpdateMetadata(process.argv[2]);
  await writeChecksums(process.argv[2]);
}
