import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as metadata from "../src/main/file-metadata";
import { FileConflictError, writeAtomic } from "../src/main/files";
import { DocumentRegistry } from "../src/main/document-registry";
import { makeRevisionId, type DiskChange } from "../src/shared/types";

setDefaultTimeout(60_000);
const dirs: string[] = [];
const original = "\uFEFFbaseline\r\nuntouched\nlast";
const mine = "\uFEFFlocal edit\r\nuntouched\nlast";
const foreign = "external newer revision\r\n";
async function fixture() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "smd-exchange-"));
  dirs.push(dir);
  const file = path.join(dir, "note.md");
  await fs.promises.writeFile(file, original);
  return { dir, file };
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.promises.chmod(dir, 0o700);
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
const exchange = metadata.exchangeFiles;
const rename = fs.promises.rename.bind(fs.promises);
async function replace(file: string, text: string) {
  await fs.promises.writeFile(`${file}.foreign`, text);
  await rename(`${file}.foreign`, file);
}

async function verifyNextSaveConflicts(file: string) {
  let injected = false;
  const inject = async () => { if (!injected) { injected = true; await replace(file, foreign); } };
  const swap = spyOn(metadata, "exchangeFiles").mockImplementation(async (...args) => {
    await inject();
    return exchange(...args);
  });
  const move = spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
    if (String(target) === file) await inject();
    return rename(source, target);
  });
  try {
    await expect(writeAtomic(file, mine, original)).rejects.toBeInstanceOf(FileConflictError);
    expect(await fs.promises.readFile(file, "utf8")).toBe(foreign);
    expect(await fs.promises.readdir(path.dirname(file))).toEqual(["note.md"]);
  } finally { swap.mockRestore(); move.mockRestore(); }
}

// The rename hook also runs on the pre-exchange implementation: its clean-save
// result is the audit's data-loss demonstration, rather than a missing mock.
test.skipIf(process.platform === "win32")("a replacement between comparison and publication conflicts without losing either version", async () => {
  const { dir, file } = await fixture();
  const registry = new DocumentRegistry(), doc = registry.create(file, original);
  doc.edit(mine, makeRevisionId(1));
  let injected = false;
  const inject = async () => { if (!injected) { injected = true; await replace(file, foreign); } };
  const swap = spyOn(metadata, "exchangeFiles").mockImplementation(async (source, target, preserve) => {
    await inject();
    return exchange(source, target, preserve);
  });
  const move = spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
    if (String(target) === file) await inject();
    return rename(source, target);
  });
  try {
    expect(await doc.save(file, doc.revisionId)).toBeNull();
    expect(injected).toBe(true);
    expect(doc.conflict).toBe(true);
    expect(doc.dirty).toBe(true);
    expect(doc.text).toBe(mine);
    expect(doc.diskText).toBe(original);
    expect(await fs.promises.readFile(file, "utf8")).toBe(foreign);
    expect(await fs.promises.readdir(dir)).toEqual(["note.md"]);
    expect(swap).toHaveBeenCalledTimes(2);
  } finally { swap.mockRestore(); move.mockRestore(); registry.dispose(); }
});

test.skipIf(process.platform === "win32")("a second replacement during rollback stays at the document path and the first gets a named sibling", async () => {
  const { dir, file } = await fixture();
  const registry = new DocumentRegistry(), doc = registry.create(file, original);
  doc.edit(mine, makeRevisionId(1));
  const changes: DiskChange[] = [];
  doc.watch(change => changes.push(change));
  let calls = 0;
  const swap = spyOn(metadata, "exchangeFiles").mockImplementation(async (source, target, preserve) => {
    calls++;
    if (calls === 1) await replace(file, foreign);
    if (calls === 2) await replace(file, "second foreign version");
    return exchange(source, target, preserve);
  });
  try {
    expect(await doc.save(file, doc.revisionId)).toBeNull();
    expect(calls).toBe(3);
    expect(await fs.promises.readFile(file, "utf8")).toBe("second foreign version");
    const siblings = (await fs.promises.readdir(dir)).filter(name => name !== "note.md");
    expect(siblings).toHaveLength(1);
    expect(siblings[0]).toStartWith("note.md.simplemd-conflict-");
    expect(await fs.promises.readFile(path.join(dir, siblings[0]!), "utf8")).toBe(foreign);
    expect(changes.some(change => change.kind === "text" && change.message?.includes(siblings[0]!))).toBe(true);
    expect(doc.text).toBe(mine);
    expect(doc.dirty).toBe(true);
    expect(doc.conflict).toBe(true);
  } finally { swap.mockRestore(); registry.dispose(); }
});

for (const changed of [false, true]) test.skipIf(process.platform === "win32")(`unsupported exchange rechecks the revision before fallback, changed=${changed}`, async () => {
  const { dir, file } = await fixture();
  const swap = spyOn(metadata, "exchangeFiles").mockImplementation(async () => {
    if (changed) await replace(file, foreign);
    return { exchanged: false, metadataCopyFailed: false };
  });
  const move = spyOn(fs.promises, "rename");
  try {
    if (changed) await expect(writeAtomic(file, mine, original)).rejects.toBeInstanceOf(FileConflictError);
    else await writeAtomic(file, mine, original);
    expect(swap).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledTimes(changed ? 0 : 1);
    expect(await fs.promises.readFile(file, "utf8")).toBe(changed ? foreign : mine);
    expect(await fs.promises.readdir(dir)).toEqual(["note.md"]);
  } finally { swap.mockRestore(); move.mockRestore(); }
});

test.skipIf(process.platform === "win32")("exchange through a symlink preserves the link and other hard links", async () => {
  const { file, dir } = await fixture();
  const link = path.join(dir, "link.md"), hard = path.join(dir, "hard.md");
  await fs.promises.symlink("note.md", link);
  await fs.promises.link(file, hard);
  const swap = spyOn(metadata, "exchangeFiles");
  try {
    await writeAtomic(link, mine, original);
    expect(swap).toHaveBeenCalledTimes(1);
    expect(swap.mock.calls[0]![1]).toBe(await fs.promises.realpath(file));
    expect((await fs.promises.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.promises.readFile(file, "utf8")).toBe(mine);
    expect(await fs.promises.readFile(hard, "utf8")).toBe(original);
  } finally { swap.mockRestore(); }
});

test.skipIf(process.platform !== "darwin")("one helper copies xattrs, tags and ACLs before exchanging the file", async () => {
  const { file } = await fixture();
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(args);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString();
  };
  run("xattr", "-w", "com.simplemd.exchange", "keep", file);
  run("xattr", "-w", "com.apple.metadata:_kMDItemUserTags", "tag", file);
  run("chmod", "+a", "everyone allow read", file);
  await fs.promises.chmod(file, 0o640);
  const attributes = run("xattr", "-lx", file);
  const acl = run("ls", "-le", file).split("\n").slice(1);
  const swap = spyOn(metadata, "exchangeFiles");
  try {
    await writeAtomic(file, mine, original);
    expect(swap).toHaveBeenCalledTimes(1);
    expect(swap.mock.calls[0]![2]).toBe(true);
    expect(await fs.promises.readFile(file)).toEqual(Buffer.from(mine));
    expect(run("xattr", "-lx", file)).toBe(attributes);
    expect(run("ls", "-le", file).split("\n").slice(1)).toEqual(acl);
    expect((await fs.promises.stat(file)).mode & 0o777).toBe(0o640);
  } finally { swap.mockRestore(); }
});

test.skipIf(process.platform === "win32")("a read-only directory cannot publish or leave a temporary file", async () => {
  const { dir, file } = await fixture();
  await fs.promises.chmod(dir, 0o500);
  const swap = spyOn(metadata, "exchangeFiles");
  try {
    await expect(writeAtomic(file, mine, original)).rejects.toThrow();
    expect(swap).not.toHaveBeenCalled();
    expect(await fs.promises.readFile(file, "utf8")).toBe(original);
    expect(await fs.promises.readdir(dir)).toEqual(["note.md"]);
  } finally { swap.mockRestore(); await fs.promises.chmod(dir, 0o700); }
  await verifyNextSaveConflicts(file);
});

for (const step of ["truncate", "writeFile", "chmod", "close"] as const) test.skipIf(process.platform === "win32")(`failure during temporary ${step} preserves the original`, async () => {
  const { dir, file } = await fixture();
  const open = fs.promises.open.bind(fs.promises);
  const handles: fs.promises.FileHandle[] = [];
  const hook = spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[1] === "wx") {
      handles.push(handle);
      spyOn(handle, step).mockRejectedValueOnce(new Error(`injected ${step}`));
    }
    return handle;
  });
  try {
    await expect(writeAtomic(file, mine, original)).rejects.toThrow(`injected ${step}`);
    expect(await fs.promises.readFile(file, "utf8")).toBe(original);
    expect(await fs.promises.readdir(dir)).toEqual(["note.md"]);
  } finally { hook.mockRestore(); for (const handle of handles) await handle.close().catch(() => {}); }
  await verifyNextSaveConflicts(file);
});

for (const step of ["publish", "displaced-read", "rollback", "returned-read", "restore-newer", "retain-sibling"] as const) test.skipIf(process.platform === "win32")(`failure during ${step} never deletes a displaced version`, async () => {
  const { dir, file } = await fixture();
  let calls = 0;
  const swap = spyOn(metadata, "exchangeFiles").mockImplementation(async (source, target, preserve) => {
    calls++;
    if (step === "publish" || step === "rollback" && calls === 2 || step === "restore-newer" && calls === 3) throw new Error(`injected ${step}`);
    if (calls === 1 && step !== "displaced-read") await replace(file, foreign);
    if (calls === 2 && ["restore-newer", "retain-sibling"].includes(step)) await replace(file, "second foreign version");
    return exchange(source, target, preserve);
  });
  const open = fs.promises.open.bind(fs.promises);
  let readFailed = false;
  const read = spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    if (!readFailed && String(args[0]).endsWith(".tmp") && typeof args[1] === "number" && (step === "displaced-read" && calls === 1 || step === "returned-read" && calls === 2)) {
      readFailed = true;
      throw new Error(`injected ${step}`);
    }
    return open(...args);
  });
  const retain = spyOn(metadata, "renameNoReplace");
  if (step === "retain-sibling") retain.mockRejectedValueOnce(new Error(`injected ${step}`));
  try {
    await expect(writeAtomic(file, mine, original)).rejects.toThrow();
    const contents = await Promise.all((await fs.promises.readdir(dir)).map(name => fs.promises.readFile(path.join(dir, name), "utf8")));
    // The original is at the document path on pre-publication/read failures;
    // otherwise the injected replacement is at the path or in the sole sibling.
    expect(contents).toContain(["publish", "displaced-read"].includes(step) ? original : foreign);
    if (["restore-newer", "retain-sibling"].includes(step)) expect(contents).toContain("second foreign version");
    expect(contents.length).toBeLessThanOrEqual(2);
  } finally { swap.mockRestore(); read.mockRestore(); retain.mockRestore(); }
});

for (const phase of ["prepared", "published", "rolled-back", "newer-restored"] as const) test.skipIf(process.platform === "win32")(`a crash after ${phase} leaves complete files and at most one recognized temporary file`, async () => {
  const { file, dir } = await fixture();
  const script = `
    import { spyOn } from 'bun:test';
    import fs from 'node:fs';
    import * as metadata from ${JSON.stringify(path.resolve(import.meta.dir, "../src/main/file-metadata.ts"))};
    import { writeAtomic } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/main/files.ts"))};
    const phase = ${JSON.stringify(phase)}, file = ${JSON.stringify(file)};
    const exchange = metadata.exchangeFiles;
    const rename = fs.promises.rename.bind(fs.promises);
    const replace = async text => { await fs.promises.writeFile(file + '.foreign', text); await rename(file + '.foreign', file); };
    let calls = 0;
    spyOn(metadata, 'exchangeFiles').mockImplementation(async (source, target, preserve) => {
      calls++;
      if (phase === 'prepared') process.exit(77);
      if (calls === 1 && phase !== 'published') await replace(${JSON.stringify(foreign)});
      if (calls === 2 && phase === 'newer-restored') await replace('second foreign version');
      const result = await exchange(source, target, preserve);
      if (calls === (phase === 'published' ? 1 : phase === 'rolled-back' ? 2 : 3)) process.exit(77);
      return result;
    });
    await writeAtomic(file, ${JSON.stringify(mine)}, ${JSON.stringify(original)});
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(77);
    const names = await fs.promises.readdir(dir);
    expect(names).toHaveLength(2);
    expect(names.filter(name => /^\.note\.md\.[\da-f-]+\.tmp$/.test(name))).toHaveLength(1);
    expect(await fs.promises.readFile(file, "utf8")).toBe(phase === "prepared" ? original : phase === "published" ? mine : phase === "rolled-back" ? foreign : "second foreign version");
    const contents = await Promise.all(names.map(name => fs.promises.readFile(path.join(dir, name), "utf8")));
    for (const content of contents) expect([original, mine, foreign, "second foreign version"]).toContain(content);
  } finally { clearTimeout(timer); child.kill("SIGKILL"); }
});

test.skipIf(process.platform === "win32")("failure creating a temporary file preserves the original", async () => {
  const { dir, file } = await fixture();
  const open = fs.promises.open.bind(fs.promises);
  const hook = spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    if (args[1] === "wx") throw new Error("injected open");
    return open(...args);
  });
  try {
    await expect(writeAtomic(file, mine, original)).rejects.toThrow("injected open");
    expect(await fs.promises.readFile(file, "utf8")).toBe(original);
    expect(await fs.promises.readdir(dir)).toEqual(["note.md"]);
  } finally { hook.mockRestore(); }
  await verifyNextSaveConflicts(file);
});

test.skipIf(process.platform === "win32")("failure removing the verified baseline restores it before reporting conflict", async () => {
  const { dir, file } = await fixture();
  const remove = spyOn(fs.promises, "unlink").mockRejectedValueOnce(new Error("injected unlink"));
  try {
    await expect(writeAtomic(file, mine, original)).rejects.toBeInstanceOf(FileConflictError);
    expect(await fs.promises.readFile(file, "utf8")).toBe(original);
    expect(await fs.promises.readdir(dir)).toEqual(["note.md"]);
  } finally { remove.mockRestore(); }
});

test.skipIf(process.platform === "win32")("a helper failure after publication retains the original instead of cleaning it up", async () => {
  const { dir, file } = await fixture();
  const swap = spyOn(metadata, "exchangeFiles").mockImplementation(async (...args) => {
    await exchange(...args);
    throw new Error("injected lost helper acknowledgement");
  });
  try {
    let conflict: unknown;
    try { await writeAtomic(file, mine, original); } catch (error) { conflict = error; }
    expect(conflict).toBeInstanceOf(FileConflictError);
    if (!(conflict instanceof FileConflictError) || !conflict.recoveryPath) throw new Error("Missing recovery path");
    expect(await fs.promises.readFile(file, "utf8")).toBe(mine);
    expect(await fs.promises.readFile(conflict.recoveryPath, "utf8")).toBe(original);
    expect(await fs.promises.readdir(dir)).toHaveLength(2);
  } finally { swap.mockRestore(); }
});
