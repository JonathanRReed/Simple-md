import { countProse } from "../../src/shared/prose-count";
import { EditorView } from "@codemirror/view";
import { foldedRanges } from "@codemirror/language";
import { createEditor } from "../../src/renderer/editor";
import { createPane } from "../../src/renderer/pane";
import { createRenderCore } from "../../src/shared/render-core";
import { DEFAULT_SETTINGS, makeDocumentId, makePaneId, makeRevisionId } from "../../src/shared/types";
import { selectedReadProse, selectedSourceRanges } from "../../src/renderer/read-selection";
import { applyDocumentStyle } from "../../src/renderer/document-style";
import { closeOverlays } from "../../src/renderer/ui";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, message: string) {
  for (let i = 0; i < 250; i++) { if (predicate()) return; await pause(); }
  throw new Error(message);
}
export async function runBatch(input: { html: string; css: string }) {
  document.body.innerHTML = new DOMParser().parseFromString(input.html, "text/html").body.innerHTML;
  document.body.dataset.platform = "darwin";
  const style = document.createElement("style"); style.textContent = input.css; document.head.append(style);
  applyDocumentStyle({ ...DEFAULT_SETTINGS, uiMotion: "off" });
  const core = createRenderCore();
  const host = { baseUrl: () => null, openLink() {}, renderFragment: (text: string) => core.renderFragment(text, undefined) };
  const parent = document.createElement("div"); parent.style.cssText = "width:600px;height:480px"; document.body.append(parent);
  const text = "---\ntitle: Hidden\n---\n\n# First\n\nNeedle **words**\n\n| A | B |\n| --- | --- |\n| one | two |\n\n```ts\nconst x = 1\n```\n\n# Last\n\nEnd";
  const editor = createEditor(parent, { text, mode: "live", host, onChange() {}, onScroll() {}, onImages: async () => null });
  const view = EditorView.findFromDOM(parent.querySelector(".cm-editor")!)!;
  editor.focus(); view.dispatch({ selection: { anchor: text.length } });
  await until(() => !!parent.querySelector(".cm-rendered-table"), "Live table never rendered");
  view.dispatch({ selection: { anchor: text.indexOf("Needle") } }); editor.fold("fold");
  assert(foldedRanges(view.state).size === 1, "Heading did not fold from its body");
  await until(() => !parent.querySelector(".cm-rendered-table"), "Folded Live table still has a replacement");
  assert(editor.getText() === text, "Folding changed source");
  editor.find("Needle"); editor.findNext();
  assert(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) === "Needle", "Find did not select the folded match");
  assert(foldedRanges(view.state).size === 0, "Find did not unfold its match");
  editor.fold("fold-all"); editor.fold("unfold-all");
  view.dispatch({ selection: { anchor: text.length } });
  await until(() => !!parent.querySelector(".cm-rendered-table"), "Unfolding lost Live decorations");
  editor.setEditable(false); editor.block("heading-2"); editor.table("insert-table");
  assert(editor.getText() === text, "A writing command changed a read-only file");
  editor.destroy(); parent.remove(); closeOverlays();

  const stage = document.querySelector<HTMLElement>("#stage")!; stage.dataset.panes = "1";
  const root = document.querySelector<HTMLTemplateElement>("#pane-template")!.content.firstElementChild!.cloneNode(true) as HTMLElement;
  for (const element of root.querySelectorAll<HTMLElement>("[id]")) element.dataset.element = element.id;
  stage.append(root);
  const clipboard: { text: string; html?: string }[] = [];
  let saved = true, saveCount = 0;
  const imageBytes: number[] = [];
  Object.assign(window, { simplemd: {
    perfMarker() {}, documentReady() {}, paneMode() {}, releaseView() {}, editing() {}, setDirty() {}, edit() {}, writingContext() {}, proseCounts: async (text: string, selection: { from: number; to: number } | undefined, mdx: boolean, _id: number, _revision: number, selectedText?: string) => countProse(text, selection, mdx, selectedText),
    changes: async () => ({ kind: null, generation: 0, changes: { changed: [], deleted: [] } }),
    renderBlocks: (text: string) => core.renderBlocks(text, "/tmp/writing.md"), renderFragment: host.renderFragment,
    readFindText: async () => "", writeFindText: async () => {},
    menuCommands: async () => [], invokeMenu: async () => {},
    writeClipboard: async (text: string, html?: string) => { clipboard.push({ text, html }); },
    renderClipboard: async (text: string) => (await core.renderBlocks(text, "/tmp/writing.md")).blocks,
    readClipboardHtml: async () => "<h2>Pasted</h2><p><strong>Text</strong></p>",
    save: async (text: string, _dialog: boolean, documentId: ReturnType<typeof makeDocumentId>) => {
      saveCount++;
      return saved ? { documentId, revisionId: makeRevisionId(0), path: "/tmp/draft.md", name: "draft.md", baseUrl: "file:///tmp/", text } : null;
    },
    saveImage: async (bytes: Uint8Array) => { imageBytes.push(...bytes); return "assets/draft-image.png"; },
    pickImage: async () => "project.png",
  } });
  const pane = createPane(root, makePaneId(0), { active: () => true, changed() {}, tabs: () => [] });
  pane.settings({ ...DEFAULT_SETTINGS, autosave: false, outlineRail: false });
  const readText = "# Title\n\nFirst **words** [link](https://example.test)\n\n```\nnot prose\n```\n\n- [ ] Task\n";
  const rendered = await core.renderBlocks(readText, "/tmp/writing.md");
  const id = makeDocumentId(1);
  await pane.load({ ...rendered, documentId: id, paneId: makePaneId(0), revisionId: makeRevisionId(0), path: "/tmp/writing.md", name: "writing.md", baseUrl: "file:///tmp/", text: readText, intent: "read" });
  const hint = root.querySelector<HTMLElement>('[data-element="hint"]')!;
  await until(() => hint.textContent?.includes("5 words") === true, "Read footer did not count prose in its worker");
  assert(!hint.hidden && hint.textContent?.includes("characters"), "Counter is hidden or lacks characters");
  const article = root.querySelector<HTMLElement>('[data-element="doc"]')!;
  const paragraph = [...article.querySelectorAll("p")].find(node => node.textContent?.startsWith("First"))!;
  const range = document.createRange(); range.selectNodeContents(paragraph);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  const sourceRanges = selectedSourceRanges(article, readText, selection);
  assert(sourceRanges.length === 1 && readText.slice(sourceRanges[0]!.from, sourceRanges[0]!.to).startsWith("First **words**"), "Read selection lacks original source range");
  pane.command("copy-markdown"); await until(() => clipboard.length === 1, "Read Markdown copy did not write");
  assert(clipboard[0]!.text === "First **words** [link](https://example.test)\n", "Read copy lost markup or copied unrelated blocks");
  pane.command("copy-html"); await until(() => clipboard.length === 2, "HTML copy did not write");
  assert(clipboard[1]!.text.includes("<strong>words</strong>") && clipboard[1]!.html === undefined, "HTML copy is not HTML text");
  pane.command("copy-formatted"); await until(() => clipboard.length === 3, "Formatted copy did not write");
  assert(clipboard[2]!.html?.includes("<strong>words</strong>") && clipboard[2]!.text.includes("First words link"), "Formatted copy lacks rich or plain formats");
  await until(() => hint.textContent?.includes("selected") === true, "Read selection count did not update");
  const partial = document.createRange(); partial.selectNodeContents(paragraph.querySelector("strong")!);
  selection.removeAllRanges(); selection.addRange(partial);
  assert(selectedReadProse(article, selection) === "words", "Partial Read selection counted its whole block");
  await until(() => hint.textContent?.startsWith("1 word · 5 characters selected") === true, "Partial Read selection count is wrong");
  const codeRange = document.createRange(); codeRange.selectNodeContents(article.querySelector("pre code")!);
  selection.removeAllRanges(); selection.addRange(codeRange);
  assert(selectedReadProse(article, selection) === "", "Selected code counted as prose");
  selection.removeAllRanges();
  const task = article.querySelector<HTMLElement>(".task-list-item")!;
  task.focus(); pane.command("toggle-task");
  await until(() => pane.flush().text === readText.replace("[ ]", "[x]"), "Focused Read task did not toggle exactly its marker");
  pane.command("undo");
  await until(() => pane.flush().text === readText, "Read task edit was not undoable");
  pane.command("mode-source");
  await until(() => !!root.querySelector(".cm-content"), "Source editor did not mount");
  const paneView = EditorView.findFromDOM(root.querySelector(".cm-editor")!)!;
  await until(() => document.activeElement === root.querySelector(".cm-content"), "Editor did not focus");
  paneView.dispatch({ selection: { anchor: readText.indexOf("words"), head: readText.indexOf("words") + 5 } });
  await until(() => hint.textContent?.includes("1 word · 5 characters selected") === true, "Editor selection count is wrong");
  assert(!hint.hidden, "Source counter is hidden");
  pane.command("paste-markdown");
  await until(() => pane.flush().text.includes("## Pasted"), "HTML paste did not insert Markdown");
  pane.command("mode-read"); await until(() => root.dataset.view === "read", "Read did not mount");
  pane.command("find-replace");
  await until(() => document.activeElement === root.querySelector('[name="replace"]'), "Replace did not switch from Read and focus its panel");
  closeOverlays();
  pane.command("go-to-line");
  await until(() => !!root.querySelector(".cm-goto-line"), "Go to Line panel did not open");

  pane.suspend();
  const hostile = 'Hello **bold**\n\n<img src="https://example.test/a.png" onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">Link</a>';
  const hostileBlocks = await core.renderBlocks(hostile, "/tmp/clipboard.md");
  pane.settings({ ...DEFAULT_SETTINGS, autosave: false, outlineRail: false, remoteImages: false });
  await pane.load({ ...hostileBlocks, documentId: makeDocumentId(3), paneId: makePaneId(0), revisionId: makeRevisionId(0), path: "/tmp/clipboard.md", name: "clipboard.md", baseUrl: "file:///tmp/", text: hostile, intent: "read" });
  const copied = clipboard.length; pane.command("copy-html");
  await until(() => clipboard.length > copied, "Author-HTML copy did not write");
  assert(!/<script|onerror|javascript:/i.test(clipboard.at(-1)!.text), "Clipboard serialization bypassed author HTML sanitization");
  assert(clipboard.at(-1)!.text.includes("<strong>bold</strong>"), "Sanitized copy lost generated Markdown");

  // The browser File remains alive across Save, and cancellation leaves the source alone.
  pane.suspend();
  const empty = await core.renderBlocks("", null);
  await pane.load({ ...empty, documentId: makeDocumentId(2), paneId: makePaneId(0), revisionId: makeRevisionId(0), path: null, name: "Untitled.md", baseUrl: null, text: "", intent: "edit" });
  const paste = () => {
    const data = new DataTransfer(); data.items.add(new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" }));
    (root.querySelector(".cm-content") as HTMLElement).focus();
    root.querySelector(".cm-content")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  };
  saved = false; paste();
  await until(() => saveCount === 1, "Unsaved paste did not request Save");
  await until(() => document.querySelector("#toast")?.textContent?.includes("not inserted") === true, "Canceled Save did not explain image loss");
  assert(pane.flush().text === "" && imageBytes.length === 0, "Canceled paste inserted or saved an image");
  saved = true; paste();
  await until(() => pane.flush().text.includes("![](assets/draft-image.png)"), "Successful Save did not finish pending paste");
  assert(imageBytes.join() === "1,2,3" && saveCount === 2, "Pending image bytes were lost");
  pane.command("insert-image");
  await until(() => pane.flush().text.includes("![](project.png)"), "Image chooser did not insert a link");
  pane.suspend(); root.remove();
  return { counter: true, folding: true, copy: true, images: true, panels: true };
}

Object.assign(globalThis, { CorpusBrowser: { runBatch } });
