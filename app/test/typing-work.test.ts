import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { Tree, TreeCursor } from "@lezer/common";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { createProseCountCache } from "../src/shared/prose-count";
import { writingFolding } from "../src/renderer/folding";
import { referenceContext } from "../src/renderer/reference-context";
import { imageHtmlRegions, codeHtmlRegions } from "../src/renderer/live-regions";

const section = "## Heading\n\nSome *emphasis*, `code`, a [link](https://example.test) and **bold** words[^1].\n\n- item one\n- item two\n\n";
const source = section.repeat(Math.ceil(100_000 / section.length)) + "\n[^1]: Note.\n";
const stateFor = () => EditorState.create({ doc: source, extensions: [markdown({ base: markdownLanguage }), writingFolding] });

test("prose counts parse a revision once and count only nonempty selections", () => {
  const count = createProseCountCache();
  const matchAll = String.prototype.matchAll;
  let wordPasses = 0, treeWalks = 0;
  const iterate = Tree.prototype.iterate;
  Tree.prototype.iterate = function (options) { treeWalks++; return iterate.call(this, options); };
  String.prototype.matchAll = function (regexp: RegExp) {
    if (regexp.source.includes("\\p{L}")) wordPasses++;
    return matchAll.call(this, regexp);
  };
  try {
    const initial = count(1, 0, source);
    wordPasses = 0;
    for (let pos = 1; pos <= 3; pos++) expect(count(1, 0, source, { from: pos, to: pos }).document).toBe(initial.document);
    const caret = wordPasses;
    count(1, 0, source, { from: 3, to: 10 }); const selection = wordPasses - caret;
    const beforeEdit = wordPasses, beforeTrees = treeWalks;
    count(1, 1, source + "x", { from: 3, to: 3 }); const edit = wordPasses - beforeEdit, editTrees = treeWalks - beforeTrees;
    count(2, 0, "Other note"); const beforeReturn = wordPasses;
    count(1, 1, source + "x");
    expect(wordPasses).toBe(beforeReturn);
    console.log(`prose tree walks per keystroke=${editTrees}`);
    console.log(`prose word counts: 3 caret moves=${caret}, selection=${selection}, keystroke=${edit}`);
    expect(editTrees).toBe(1);
    expect({ caret, selection, edit }).toEqual({ caret: 0, selection: 1, edit: 1 });
  } finally { String.prototype.matchAll = matchAll; Tree.prototype.iterate = iterate; }
});

test("typing and caret updates schedule no table menu IPC", async () => {
  // Execute the actual hint-update closure with a deterministic scheduler and IPC sink.
  const pane = (await Bun.file(new URL("../src/renderer/pane.ts", import.meta.url)).text()).replace(/\r\n/g, "\n");
  const from = pane.indexOf("  function updateHint(): void {");
  const body = pane.slice(from, pane.indexOf("\n  }", from) + 4).replace("(): void", "()");
  let messages = 0, counts = 0;
  const update = new Function("hintEl", "doc", "counter", "simplemd", "pane", "options", "disposed", "setTimeout", "clearTimeout", `let writingTimer; ${body}; return updateHint;`)(
    {}, { hasDoc: true }, { schedule() { counts++; } }, { writingContext() { messages++; } },
    { view: "edit", documentId: 1, editor: { inTable: () => false } }, { active: () => true }, false,
    (fn: () => void) => { fn(); return 1; }, () => {},
  );
  update(); update(); // One typing pause and one caret move.
  console.log(`table context IPC: ${messages / 2} per typing/caret pause`);
  expect(counts).toBe(2); expect(messages).toBe(0);
});

test("folding schedules no syntax indexing after a keystroke", () => {
  const queued: (() => void)[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout(fn: () => void) { queued.push(fn); return 1; }, clearTimeout() {}, cancelIdleCallback() {},
    requestIdleCallback(fn: (deadline: { timeRemaining(): number }) => void) { queued.push(() => fn({ timeRemaining: () => 100 })); return 1; },
  } });
  let state = stateFor(); ensureSyntaxTree(state, state.doc.length, 5_000);
  const view = { get state() { return state; }, dispatch(spec: Parameters<EditorState["update"]>[0]) { state = state.update(spec).state; } } as EditorView;
  const plugins: { update?(update: ViewUpdate): void; destroy?(): void }[] = [];
  const collect = (extensions: unknown) => {
    for (const extension of Array.isArray(extensions) ? extensions : [extensions]) {
      if (extension instanceof ViewPlugin) plugins.push(Reflect.get(extension, "create")(view));
    }
  };
  try {
    collect(writingFolding);
    while (queued.length) queued.shift()!();
    const startState = state; state = state.update({ changes: { from: 50, insert: "x" } }).state;
    ensureSyntaxTree(state, state.doc.length, 5_000);
    for (const plugin of plugins) plugin.update?.({ docChanged: true, state, startState } as ViewUpdate);
    const scheduled = queued.length;
    let visited = 0;
    const next = TreeCursor.prototype.next;
    TreeCursor.prototype.next = function (enter) { visited++; return next.call(this, enter); };
    try { while (queued.length) queued.shift()!(); } finally { TreeCursor.prototype.next = next; }
    console.log(`fold index cursor visits per keystroke=${visited}`);
    expect(visited).toBe(0);
    console.log(`fold indexing tasks after a keystroke=${scheduled}`);
    expect(scheduled).toBe(0);
  } finally {
    plugins.forEach(plugin => plugin.destroy?.());
    if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("Live reference and HTML context scans share one whole-tree walk per keystroke", () => {
  let state = stateFor(); ensureSyntaxTree(state, state.doc.length, 5_000);
  let walks = 0;
  const iterate = Tree.prototype.iterate;
  Tree.prototype.iterate = function (options) { if (options.from === undefined) walks++; return iterate.call(this, options); };
  try {
    for (let i = 0; i < 3; i++) {
      state = state.update({ changes: { from: 50, insert: "x" } }).state;
      const tree = ensureSyntaxTree(state, state.doc.length, 5_000)!;
      referenceContext(state, tree); codeHtmlRegions(state, tree); imageHtmlRegions(state, tree);
      referenceContext(state, tree); codeHtmlRegions(state, tree);
    }
    console.log(`Live whole-tree context walks=${walks / 3} per keystroke`);
    expect(walks).toBe(3);
  } finally { Tree.prototype.iterate = iterate; }
});
