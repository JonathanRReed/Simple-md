import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const directory = path.resolve(import.meta.dirname, "../test/fixtures/perf");
const paragraph = "A deterministic paragraph with **bold**, `code`, and a [local anchor](#perf-medium). " + "readable text ".repeat(280) + "\n\n";
function sized(title: string, bytes: number): string {
  const prefix = `# ${title}\n\n`;
  const body = paragraph.repeat(Math.ceil(bytes / paragraph.length));
  return (prefix + body).slice(0, bytes - 1) + "\n";
}
const small = "# Perf README\n\nA small synthetic README for the local performance gate.\n\n## Usage\n\nOpen, read, edit, and save.\n\n```ts\nconst answer = 42;\n```\n\n- [ ] Check the result\n";
export function perfFixtures(): Record<string, string> {
  return {
    "small.md": small,
    "medium.md": sized("Perf medium", 90_000),
    "huge.md": sized("Perf huge", 2_000_000),
    "ceiling.md": sized("Perf ceiling", 20_000_000),
    "typing-100k.md": sized("Perf typing", 100_000),
    "math.md": "# Perf math\n\n" + Array.from({ length: 40 }, (_, i) => `$$\nx_{${i}} = \\frac{a+b}{c} + \\sum_{n=1}^{10} n^2\n$$\n\n`).join(""),
    "diagrams.md": "# Perf diagrams\n\n" + Array.from({ length: 8 }, (_, i) => `\`\`\`mermaid\ngraph LR\nA${i}[Start]-->B${i}[Finish]\n\`\`\`\n\n`).join(""),
    "fences.md": "# Perf fences\n\n" + Array.from({ length: 64 }, (_, i) => `\`\`\`${i % 2 ? "python" : "ts"}\n${i % 2 ? `answer_${i} = ${i}` : `const answer${i} = ${i};`}\n\`\`\`\n\n`).join(""),
    "long-lines.md": "# Perf long lines\n\n" + "unbroken".repeat(8000) + "\n",
    "unicode.md": "# Perf Unicode\n\nCafé, 中文, العربية, עברית, e\u0301, 𝄞, 🧑🏽‍💻, 🚀.\n",
    "crlf.md": small.replaceAll("\n", "\r\n"),
    "mixed.md": "# Perf mixed\r\n\r\nFirst paragraph.\n\nSecond paragraph.\r\nLast line.\n",
    "bom.md": "\uFEFF# Perf BOM\n\nA UTF-8 byte order mark.\n",
    "astro.mdx": `---\ntitle: "Perf synthetic Astro post"\ndescription: "A fixture written for this repository"\npubDate: 2026-01-01\ntags: [writing, tools]\n---\n\nimport Callout from '../../components/Callout.astro';\n\n# Perf synthetic Astro post\n\nThis synthetic post does not contain the owner's writing.\n\n<figure>\n  <img src="/images/perf-example.png" alt="Synthetic example" />\n  <figcaption>A local image example.</figcaption>\n</figure>\n\n<Callout tone="note">\nA component stays inert.\n</Callout>\n\nA value stays inert: {2 + 2}.\n`,
  };
}
export function fixtureManifest() {
  return { generatorSha256: sha256(fs.readFileSync(import.meta.filename)), fixtures: Object.entries(perfFixtures()).map(([name, text]) => ({ name, bytes: Buffer.byteLength(text), sha256: sha256(text), generated: Buffer.byteLength(text) > 10_000 })) };
}
export function writePerfFixtures(target: string): ReturnType<typeof fixtureManifest> {
  const manifest = fixtureManifest();
  const committed: unknown = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  if (JSON.stringify(committed) !== JSON.stringify(manifest)) throw new Error("Performance fixture manifest drift. Run bun scripts/perf-fixtures.ts --write and review the change.");
  fs.mkdirSync(target, { recursive: true });
  for (const [name, text] of Object.entries(perfFixtures())) fs.writeFileSync(path.join(target, name), text);
  return manifest;
}
if (import.meta.main && process.argv.includes("--write")) {
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, text] of Object.entries(perfFixtures())) if (Buffer.byteLength(text) <= 10_000) fs.writeFileSync(path.join(directory, name), text);
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(fixtureManifest(), null, 2) + "\n");
}
