import type { DriverStep } from "../src/main/driver";

export type InputMethod = "native" | "cdp";
export const typingLetters = "abcdefghijklmnopqrstuvwxyz0123456789abcd";
export const typingProbe = `
  window.perfEvents = []; window.perfCounts = { keydown: 0, beforeinput: 0 }; window.perfRaf = [];
  window.perfObserver = new PerformanceObserver(list => {
    for (const e of list.getEntries()) if (e.name === 'keydown' || e.name === 'beforeinput') window.perfEvents.push(e.toJSON());
  });
  window.perfObserver.observe({ type: 'event', durationThreshold: 16 });
  for (const name of ['keydown', 'beforeinput']) content.addEventListener(name, e => {
    if (!e.isTrusted) throw new Error('Untrusted perf input');
    window.perfCounts[name]++;
    if (name === 'beforeinput') {
      const start = performance.now();
      requestAnimationFrame(() => window.perfRaf.push(performance.now() - start));
    }
  });
`;
export const typingRecord = `({ supported: PerformanceObserver.supportedEntryTypes, counts: window.perfCounts,
  events: [...window.perfEvents, ...window.perfObserver.takeRecords().map(e => e.toJSON()).filter(e => e.name === 'keydown' || e.name === 'beforeinput')],
  lowerBound: window.perfRaf })`;
export function typingInput(letter: string, method: InputMethod): DriverStep[] {
  if (method === "native") return [
    { input: { type: "keyDown", keyCode: letter.toUpperCase() } },
    { input: { type: "char", keyCode: letter } },
    { input: { type: "keyUp", keyCode: letter.toUpperCase() } },
  ];
  return [
    { debug: { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: letter, code: /^[0-9]$/.test(letter) ? `Digit${letter}` : `Key${letter.toUpperCase()}`, text: letter, windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0) } } },
    { debug: { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: letter, code: /^[0-9]$/.test(letter) ? `Digit${letter}` : `Key${letter.toUpperCase()}` } } },
  ];
}

type Quantile = { lower: number; upper: number; upperExclusive: boolean };
export function calibratedTyping(editor: Quantile | null, control: Quantile | null, frameMs: number | null, count: number, minimum = 40) {
  const excess = editor && control ? {
    lower: Math.max(0, editor.lower - control.upper), upper: Math.max(0, editor.upper - control.lower),
  } : null;
  // Compare conservative censoring bounds. The 8 ms allowance is one Event Timing quantum.
  const target = frameMs !== null && Number.isFinite(frameMs) && frameMs > 0 ? frameMs + 8 : null;
  return { status: excess && target !== null && count >= minimum && excess.upper <= target ? "pass" : "fail",
    count, minimum, excessP95Ms: excess, target, frameMs, quantizationMs: 8,
    reason: "Keydown p95 above the matched empty textarea must be at most one display frame plus one 8 ms Event Timing quantum. beforeinput and rAF remain diagnostics; missing Event Timing or control evidence fails." };
}
