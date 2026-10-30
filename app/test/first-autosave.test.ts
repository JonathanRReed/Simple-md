import { expect, test } from "bun:test";
import { FirstAutosave } from "../src/shared/first-autosave";

test("a tiny first burst stays unsaved even after idle and repeated flushes", () => {
  const guard = new FirstAutosave("Original", true);
  guard.edit("Originalx", 0); guard.edit("Originalxy", 100); guard.edit("Originalxyz", 200);
  guard.edit("Originalxyz", 9000);
  expect(guard.allowed).toBe(false);
  guard.edit("Originalxyza", 9100);
  expect(guard.allowed).toBe(true);
});
test("twelve edited characters or explicit save releases the first-save guard", () => {
  const guard = new FirstAutosave("Original", true);
  for (let i = 1; i <= 11; i++) { guard.edit("Original" + "x".repeat(i), i * 20); expect(guard.allowed).toBe(false); }
  guard.edit("Original" + "x".repeat(12), 240); expect(guard.allowed).toBe(true);
  const explicit = new FirstAutosave("Original", true);
  explicit.edit("Originalx"); explicit.confirm(); explicit.edit("Originalxy"); expect(explicit.allowed).toBe(true);
  expect(new FirstAutosave("Original", false).allowed).toBe(true);
});
test("separate single-character edits do not count untouched text between them", () => {
  const guard = new FirstAutosave("abcdefghijklmnopqrstuvwxyz", true);
  guard.edit("Abcdefghijklmnopqrstuvwxyz", 0); guard.edit("AbcdefghijklmnopqrstuvwxyZ", 100);
  expect(guard.allowed).toBe(false);
});

test("incoming disk updates and undo to the saved baseline do not release autosave", () => {
  const guard = new FirstAutosave("Before", true);
  guard.baseline("A long incoming document from disk");
  guard.edit("A long incoming document from diskx", 9000);
  expect(guard.allowed).toBe(false);
  guard.baseline("A long incoming document from disk");
  guard.edit("A long incoming document from disky", 15000);
  expect(guard.allowed).toBe(false);
});
