import { EditorView } from "@codemirror/view";
import { createEditor } from "../../src/renderer/editor";
import { createPane } from "../../src/renderer/pane";
import { openPicker, closeOverlays, openReadFind, isPickerOpen } from "../../src/renderer/ui";
import { openQuickly } from "../../src/renderer/open-quickly";
import { createRenderCore } from "../../src/shared/render-core";
import { DEFAULT_SETTINGS, LIVE_MAX_CHARS, makeDocumentId, makePaneId, makeRevisionId } from "../../src/shared/types";
import { applyDocumentStyle } from "../../src/renderer/document-style";
import { addPrintTitle } from "../../src/renderer/print-title";
import { readerFocus } from "../../src/renderer/reader-focus";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const pause = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, message: string) {
  for (let i = 0; i < 150; i++) { if (check()) return; await pause(10); }
  throw new Error(message);
}
const key = (target: HTMLElement, key: string, more: KeyboardEventInit = {}) => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...more }));

export async function runBatch(input: { html: string; css: string }) {
  document.body.innerHTML = new DOMParser().parseFromString(input.html, "text/html").body.innerHTML;
  document.body.dataset.platform = "darwin";
  const style = document.createElement("style"); style.textContent = input.css; document.head.append(style);
  applyDocumentStyle({ ...DEFAULT_SETTINGS, uiMotion: "off" });
  const core = createRenderCore();
  const host = { baseUrl: () => null, openLink() {}, renderFragment: (text: string) => core.renderFragment(text, undefined) };
  const parent = document.createElement("div"); parent.style.cssText = "width:700px;height:500px"; document.body.append(parent);
  const text = 'alpha alpha\n\n| A | B |\n| --- | --- |\n| one | two |\n\n- [ ] Task\n\nEnd';
  const fallback: boolean[] = [];
  const ed = createEditor(parent, { text, mode: "source", host, onChange() {}, onScroll() {}, onImages: async () => null, onLiveFallback: off => fallback.push(off) });
  const view = EditorView.findFromDOM(parent.querySelector(".cm-editor")!)!;
  ed.focus(); view.dispatch({ selection: { anchor: 0, head: 5 } }); ed.format("bold");
  assert(ed.getText().startsWith("**alpha**"), "Formatting does not work in editor content");
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  ed.find();
  const search = parent.querySelector<HTMLInputElement>('[name="search"]')!;
  const formatted = ed.getText(); ed.format("italic");
  assert(ed.getText() === formatted && document.activeElement === search, "Formatting edited the retained selection behind Find");
  search.value = "alpha"; search.dispatchEvent(new Event("input", { bubbles: true })); search.dispatchEvent(new Event("change", { bubbles: true }));
  await until(() => parent.querySelector(".search-count")?.textContent === "2 matches", "Find begins at 0 of N");
  ed.findNext(); await until(() => parent.querySelector(".search-count")?.textContent === "1 of 2", "Editor Find Next failed");
  ed.findNext(); await until(() => parent.querySelector(".search-count")?.textContent === "2 of 2", "Editor Find Next did not advance");
  ed.findNext(true); await until(() => parent.querySelector(".search-count")?.textContent === "1 of 2", "Editor Find Previous failed");
  ed.setEditable(false); ed.focus(); ed.format("link"); assert(ed.getText() === formatted, "Read-only formatting changed source");
  ed.setMode("live"); view.dispatch({ selection: { anchor: view.state.doc.length } });
  await until(() => !!parent.querySelector<HTMLInputElement>(".cm-task")?.disabled, "Read-only task widget remains enabled");
  parent.querySelector<HTMLInputElement>(".cm-task")!.click(); assert(ed.getText() === formatted, "Read-only task changed source");
  ed.setEditable(true);
  await until(() => parent.querySelector<HTMLInputElement>(".cm-task")?.disabled === false, "Task did not become editable");
  await until(() => !!parent.querySelector(".cm-rendered-table td"), "Live table did not render");
  const cell = parent.querySelectorAll<HTMLTableCellElement>(".cm-rendered-table td")[1]!;
  cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  assert(view.state.sliceDoc(view.state.selection.main.head).startsWith("two"), "Table click missed its cell source");
  ed.setText('**small**\n\n' + 'x'.repeat(LIVE_MAX_CHARS));
  assert(fallback.join() === 'true' && !parent.querySelector('.cm-strong'), "Crossing the Live limit did not enable Source fallback once");
  view.dispatch({ changes: { from: view.state.doc.length, insert: 'x' } });
  assert(fallback.length === 1, "Fallback reconfigured on every large edit");
  ed.setText('**small**\n\nEnd'); view.dispatch({ selection: { anchor: view.state.doc.length } });
  await until(() => !!parent.querySelector('.cm-strong'), "Live did not return below the limit");
  assert(fallback.join() === 'true,false', "Threshold crossings did not each report once");
  ed.destroy(); parent.replaceChildren();
  const large = createEditor(parent, { text: '**small**\n\n' + 'x'.repeat(LIVE_MAX_CHARS), mode: 'live', host, onChange() {}, onScroll() {}, onImages: async () => null });
  large.setText('**small**\n\nEnd');
  await until(() => !!parent.querySelector('.cm-strong'), "Initially oversized document never entered Live after deletion");
  large.destroy(); parent.replaceChildren();
  const referenceText = '![Logo][logo]\n\n| Link |\n| --- |\n| [Site][site] |\n\n[logo]: https://example.test/old.png\n[site]: https://example.test/old\n\nEnd';
  const referenceRequests: string[] = [];
  const referenceHost = { ...host, renderFragment(text: string) { referenceRequests.push(text); return host.renderFragment(text); } };
  const reference = createEditor(parent, { text: referenceText, mode: 'live', host: referenceHost, onChange() {}, onScroll() {}, onImages: async () => null });
  const referenceView = EditorView.findFromDOM(parent.querySelector('.cm-editor')!)!;
  referenceView.dispatch({ selection: { anchor: referenceView.state.doc.length } });
  await until(() => referenceRequests.some(text => text.startsWith('![Logo]') && text.includes('/old.png')) && !!parent.querySelector('a[href$="/old"]'), 'Live lost reference definitions');
  referenceView.dispatch({ changes: [...referenceText.matchAll(/old/g)].map(m => ({ from: m.index, to: m.index + 3, insert: 'new' })) });
  await until(() => referenceRequests.some(text => text.startsWith('![Logo]') && text.includes('/new.png')) && !!parent.querySelector('a[href$="/new"]'), 'Definition changes did not invalidate existing widgets');
  reference.destroy(); parent.remove();

  const restore = document.createElement('textarea'); document.body.append(restore); restore.focus();
  const pickerInput = document.querySelector<HTMLInputElement>('#picker-input')!;
  for (const placeholder of ['Open Quickly', 'Commands', 'Go to heading']) {
    let chosen = 0;
    const items = [{ label: 'First', run() { chosen++; } }, { label: 'Second', run() { chosen++; } }];
    openPicker(placeholder, items, () => restore.focus());
    for (const composingKey of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) key(pickerInput, composingKey, { isComposing: true });
    key(pickerInput, 'Enter', { keyCode: 229 });
    assert(isPickerOpen() && chosen === 0 && pickerInput.getAttribute('aria-activedescendant') === 'picker-opt-0', `${placeholder} handled an IME key`);
    key(pickerInput, 'Escape');
  }
  // The lazy replacement must retain the focus target captured before the first picker.
  restore.focus(); openPicker('Open Quickly', [], () => restore.focus());
  openQuickly({ quicklyOpen: async () => true, quicklyClose() {}, quicklyQuery: async () => [], onQuicklyResults: () => () => {} }, 'repo', [], '', restore);
  key(pickerInput, 'Escape'); assert(document.activeElement === restore, 'Lazy picker restored its hidden input');
  restore.remove();

  const stage = document.querySelector<HTMLElement>('#stage')!; stage.dataset.panes = '1';
  const root = document.querySelector<HTMLTemplateElement>('#pane-template')!.content.firstElementChild!.cloneNode(true) as HTMLElement;
  for (const el of root.querySelectorAll<HTMLElement>('[id]')) el.dataset.element = el.id;
  stage.append(root);
  let headReads = 0, committed = false;
  let delayRead = false, releaseRead: (() => void) | undefined;
  const paneText = '# First\n\nalpha alpha\n\n# Last\n\nEnd';
  const rendered = await core.renderBlocks(paneText, '/tmp/plan.md');
  Object.assign(window, { simplemd: {
    perfMarker() {}, documentReady() {}, paneMode() {}, releaseView() {}, editing() {}, setDirty() {}, edit() {},
    changes: async () => ({ kind: 'head', generation: headReads, changes: { changed: committed ? [] : [[2, 3]], deleted: [] } }),
    headChanges: async () => { headReads++; return { available: true, active: true }; },
    renderBlocks: async () => { if (delayRead) { delayRead = false; await new Promise<void>(resolve => { releaseRead = resolve; }); } return rendered; }, renderFragment: host.renderFragment,
    relativePath: async () => null, readFindText: async () => '', writeFindText: async () => {},
  } });
  const pane = createPane(root, makePaneId(0), { active: () => true, changed() {}, tabs: () => [] });
  pane.settings({ ...DEFAULT_SETTINGS, autosave: false, outlineRail: false });
  await pane.load({ ...rendered, documentId: makeDocumentId(1), paneId: makePaneId(0), revisionId: makeRevisionId(0), path: '/tmp/plan.md', name: 'plan.md', baseUrl: 'file:///tmp/', text: paneText, intent: 'read' });
  for (const cmd of ['mode-source', 'mode-live', 'mode-split'] as const) {
    document.querySelector<HTMLInputElement>('#picker-input')!.focus(); pane.command(cmd);
    await until(() => root.querySelector('.cm-content') === document.activeElement, `${cmd} did not focus editor content`);
  }
  pane.command('mode-source');
  const paneView = EditorView.findFromDOM(root.querySelector('.cm-editor')!)!;
  paneView.dispatch({ changes: { from: 0, insert: 'Edited ' } });
  pane.command('find'); await until(() => !!root.querySelector('[name="search"]'), 'Find did not open');
  const query = root.querySelector<HTMLInputElement>('[name="search"]')!; query.focus();
  document.execCommand('insertText', false, 'query');
  const beforeHistory = pane.flush().text;
  pane.command('undo'); assert(pane.flush().text === beforeHistory && query.value === '', 'Undo reached the document behind Find');
  pane.command('redo'); assert(pane.flush().text === beforeHistory && query.value === 'query', 'Redo reached the document behind Find');
  pane.command('format-bold'); assert(pane.flush().text === beforeHistory, 'Formatting reached the document behind Find');
  for (const cmd of ['palette', 'outline'] as const) {
    pane.command(cmd); pane.command('undo'); pane.command('format-link');
    assert(pane.flush().text === beforeHistory, `${cmd} allowed document mutation`); closeOverlays();
  }
  delayRead = true; pane.command('mode-read');
  await until(() => !!releaseRead, 'Read mode did not start rendering');
  let headingJumps = 0;
  const heading = root.querySelector<HTMLElement>('#user-content-last')!;
  heading.scrollIntoView = () => { headingJumps++; };
  const navigation = pane.navigate({ kind: 'heading', heading: 'last' });
  await Promise.resolve(); assert(headingJumps === 0, 'Heading navigation ran before the target finished entering Read');
  releaseRead!(); await navigation;
  assert(headingJumps === 1, 'Heading navigation was lost after entering Read');
  const article = root.querySelector<HTMLElement>('#doc')!;
  openReadFind(article, () => {}, 'alpha');
  pane.command('find-next'); assert(document.querySelector('#find-count')?.textContent === '2 of 2', 'Read Find Next failed');
  pane.command('find-previous'); assert(document.querySelector('#find-count')?.textContent === '1 of 2', 'Read Find Previous failed');
  closeOverlays();
  await until(() => root.querySelector('#change-count')?.textContent === '1 change', 'Initial HEAD change missing');
  committed = true;
  pane.saved({ revisionId: makeRevisionId(0), documentId: makeDocumentId(1), path: '/tmp/plan.md', name: 'plan.md', baseUrl: 'file:///tmp/', text: pane.flush().text });
  const readsBeforeFocus = headReads;
  window.dispatchEvent(new Event('focus'));
  await until(() => headReads > readsBeforeFocus && root.querySelector<HTMLElement>('#changes')!.hidden, 'Focus did not refresh HEAD after a commit');
  await pane.navigate({ kind: 'heading', heading: 'last' });
  assert(article.querySelector('#user-content-last'), 'New-tab heading target did not mount');

  const scroller = root.querySelector<HTMLElement>('#read-scroll')!;
  const stopFocus = readerFocus(scroller);
  query.blur(); scroller.focus();
  // Hidden windows can change activeElement without delivering native focus events.
  scroller.dispatchEvent(new FocusEvent('focus'));
  assert(!scroller.hasAttribute('data-keyboard-focus') && getComputedStyle(scroller).outlineStyle === 'none', 'Programmatic focus restored the page frame');
  scroller.blur(); scroller.dispatchEvent(new FocusEvent('blur'));
  key(document.body, 'Tab'); scroller.focus(); scroller.dispatchEvent(new FocusEvent('focus'));
  assert(scroller.dataset.keyboardFocus === 'true', 'Keyboard traversal lost the reader indicator');
  stopFocus();
  const footer = root.querySelector<HTMLElement>('.pane-status')!;
  root.querySelector<HTMLElement>('#changes')!.hidden = false;
  root.querySelector<HTMLElement>('#change-count')!.textContent = '12 changes';
  root.style.cssText = 'flex:none;width:300px'; await pause();
  const controls = root.querySelector<HTMLElement>('.change-controls')!;
  const mark = root.querySelector<HTMLElement>('#mark-seen')!;
  assert(getComputedStyle(root.querySelector('.drag-export-controls')!).display === 'none', 'Narrow pane retained export controls');
  assert(controls.scrollWidth <= footer.clientWidth && mark.getBoundingClientRect().height < 30, 'Change controls wrap or overflow');
  const codeBlock = document.createElement('div'); codeBlock.className = 'code-block'; codeBlock.dataset.lang = 'typescript';
  const pre = document.createElement('pre'); pre.textContent = 'const firstLine = 1'; codeBlock.append(pre); article.append(codeBlock);
  const codeRange = document.createRange(); codeRange.selectNodeContents(pre);
  assert(codeRange.getBoundingClientRect().top > codeBlock.getBoundingClientRect().top + 24, 'Language label overlaps the first line');
  pane.suspend();

  const print = document.createElement('article');
  const metadataText = '---\ntitle: Printed title\n---\n\nBody';
  const metadata = await core.renderMarkdown(metadataText, '/tmp/post.md');
  const { mountRenderedHtml } = await import('../../src/renderer/author-html');
  mountRenderedHtml(print, metadata, false);
  addPrintTitle(print, { text: metadataText, title: metadata.title });
  assert(print.firstElementChild?.tagName === 'H1' && print.firstElementChild.textContent === 'Printed title', 'Frontmatter title is absent from print');
  addPrintTitle(print, { text: metadataText, title: metadata.title });
  assert(print.querySelectorAll('h1').length === 1, 'Print title duplicated an existing H1');
  const imageRule = [...style.sheet!.cssRules].filter(rule => rule instanceof CSSMediaRule && rule.conditionText === 'print').flatMap(rule => [...(rule as CSSMediaRule).cssRules]).find(rule => rule instanceof CSSStyleRule && rule.selectorText === '.prose img');
  assert(imageRule instanceof CSSStyleRule && imageRule.style.maxHeight.includes('--printable-height'), 'Print images have no page-height limit');
  return { editor: true, picker: true, pane: true, layout: true, print: true };
}
Object.assign(globalThis, { CorpusBrowser: { runBatch } });
