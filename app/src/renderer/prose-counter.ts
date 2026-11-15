import type { ProseCounts } from "../shared/prose-count.js";
import type { SourceSelection } from "./source-edit.js";

export function displayCounts(output: HTMLElement, counts: ProseCounts): void {
  const format = (count: ProseCounts["document"]) => `${count.words.toLocaleString()} ${count.words === 1 ? "word" : "words"} · ${count.characters.toLocaleString()} ${count.characters === 1 ? "character" : "characters"}`;
  output.textContent = (counts.selection ? `${format(counts.selection)} selected / ` : "") + `${format(counts.document)} · ${counts.minutes} min read`;
  output.title = output.textContent;
}
/** `key` names the document revision, so a caret move within one revision reuses its counts. */
interface CounterSnapshot { key: string; text: string; selection?: SourceSelection; mdx: boolean; selectedText?: string }
export function createProseCounter(output: HTMLElement, snapshot: () => CounterSnapshot | null, count: (source: CounterSnapshot) => Promise<ProseCounts | null>) {
  let timer: ReturnType<typeof setTimeout> | undefined, sequence = 0, running = false, pending = false, disposed = false;
  let last: { key: string; counts: ProseCounts } | undefined;
  async function compute(expected: number): Promise<void> {
    if (running) { pending = true; return; }
    const source = snapshot();
    if (!source || disposed) { output.textContent = ""; return; }
    const selecting = !!source.selectedText || !!source.selection && source.selection.from !== source.selection.to;
    // Moving the caret changes nothing that is counted. Only a new revision or a selection needs the worker.
    if (!selecting && last?.key === source.key) { displayCounts(output, { document: last.counts.document, minutes: last.counts.minutes }); return; }
    running = true;
    try {
      const counts = await count(source);
      if (counts) last = { key: source.key, counts };
      if (counts && expected === sequence && !disposed) displayCounts(output, counts);
    } catch { /* Replaced documents and stale revisions have no count to display. */ }
    finally {
      running = false;
      if (pending && !disposed) { pending = false; void compute(sequence); }
    }
  }
  return {
    schedule() {
      disposed = false; sequence++;
      clearTimeout(timer);
      timer = setTimeout(() => { void compute(sequence); }, 350);
    },
    destroy() { disposed = true; sequence++; pending = false; clearTimeout(timer); },
  };
}
