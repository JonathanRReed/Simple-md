type Pele = typeof import("pele/lazy");

let coreLoad: Promise<Pele> | undefined;
// Diagrams are owned by the container that rendered them, so the read view, split preview and live-editor widgets clean up independently.
interface DiagramRoot {
  observer?: IntersectionObserver;
  jobs: Set<Job>;
  ready: Promise<void>;
  disposed: boolean;
}
interface Job {
  node: HTMLElement;
  source: string;
  owner: DiagramRoot;
  root: HTMLElement;
  queued: boolean;
  finish(): void;
}
const mountedByRoot = new WeakMap<Element, DiagramRoot>();
const queue: Job[] = [];
const CONCURRENCY = 2;
let active = 0;
let svgId = 0;
const svgCache = new Map<string, { source: string; svg: Node; bytes: number }>();
const CACHE_BYTES = 4 * 1024 * 1024;
let cacheBytes = 0;

const loadCore = () => (coreLoad ??= import("pele/lazy").catch((err) => {
  coreLoad = undefined;
  throw err;
}));

type Purifier = typeof import("dompurify")["default"];
let purifier: ReturnType<Purifier> | undefined;

// Pele already escapes labels and drops links and images. This is the second layer
// against anything that could navigate, run script, or fetch remote content.
let purifierLoad: Promise<void> | undefined;
async function loadPurifier(): Promise<void> {
  purifierLoad ??= import("dompurify").then(({ default: create }) => {
    purifier = create(window);
  });
  await purifierLoad;
}

function sanitizeSvg(svg: string): Node {
  return purifier!.sanitize(svg, {
    FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
    FORBID_TAGS: ["a", "image", "foreignObject", "style"],
    USE_PROFILES: { svg: true, svgFilters: true },
    RETURN_DOM_FRAGMENT: true,
  });
}

function errorBlock(message: string, source: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "diagram-error";
  const msg = document.createElement("p");
  msg.textContent = `Unable to render diagram: ${message}`;
  const pre = document.createElement("pre");
  pre.textContent = source;
  box.append(msg, pre);
  return box;
}

function current(job: Job): boolean {
  return !job.owner.disposed && mountedByRoot.get(job.root) === job.owner && job.root.contains(job.node) && job.node.isConnected;
}

function cloneSvg(template: Node): Node {
  const fragment = template.cloneNode(true) as DocumentFragment;
  const ids = new Map<string, string>();
  const prefix = `smd-diagram-${++svgId}-`;
  for (const node of fragment.querySelectorAll("[id]")) {
    const old = node.id;
    node.id = prefix + old;
    ids.set(old, node.id);
  }
  for (const node of fragment.querySelectorAll("*")) for (const attr of [...node.attributes]) {
    let value = attr.value.replace(/url\(#([^)]*)\)/g, (match, id: string) => ids.has(id) ? `url(#${ids.get(id)})` : match);
    if (attr.name === "aria-labelledby" || attr.name === "aria-describedby") value = value.split(/\s+/).map(id => ids.get(id) ?? id).join(" ");
    if (value !== attr.value) node.setAttribute(attr.name, value);
  }
  return fragment;
}

async function render(job: Job): Promise<void> {
  if (!current(job)) return;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(job.source));
  const key = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  let cached = svgCache.get(key);
  if (cached?.source !== job.source) cached = undefined;
  if (!cached) {
    const [pele] = await Promise.all([loadCore(), loadPurifier()]);
    if (!current(job)) return;
    const type = pele.detectType(job.source);
    if (!type) throw new Error("Unrecognized diagram type.");
    if (!(await pele.load(type))) throw new Error("The diagram renderer failed to load.");
    if (!current(job)) return;
    const result = pele.render(job.source, { links: false, images: false, autoDirection: false });
    cached = { source: job.source, svg: sanitizeSvg(result.svg), bytes: (result.svg.length + job.source.length) * 2 };
    while (svgCache.size && (cacheBytes + cached.bytes > CACHE_BYTES || svgCache.size >= 128)) {
      const oldest = svgCache.keys().next().value!;
      cacheBytes -= svgCache.get(oldest)!.bytes;
      svgCache.delete(oldest);
    }
    if (cached.bytes <= CACHE_BYTES) { svgCache.set(key, cached); cacheBytes += cached.bytes; }
  } else {
    svgCache.delete(key);
    svgCache.set(key, cached);
  }
  if (!current(job)) return;
  const holder = document.createElement("div");
  holder.className = "diagram";
  const canvas = document.createElement("div");
  canvas.className = "diagram-canvas";
  canvas.append(cloneSvg(cached.svg));
  holder.append(canvas);
  job.node.replaceWith(holder);
}

function drain(): void {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift()!;
    if (!current(job)) { job.finish(); continue; }
    active++;
    void render(job).catch(error => {
      if (current(job)) job.node.replaceWith(errorBlock(error instanceof Error ? error.message : "The diagram could not be rendered.", job.source));
    }).finally(() => { active--; job.finish(); drain(); });
  }
}

function enqueue(job: Job): void {
  if (job.queued) return;
  job.queued = true;
  job.owner.observer?.unobserve(job.node);
  queue.push(job);
  drain();
}

export function destroyDiagrams(root: Element): void {
  const owner = mountedByRoot.get(root);
  if (!owner) return;
  owner.disposed = true;
  owner.observer?.disconnect();
  for (const job of owner.jobs) job.finish();
  mountedByRoot.delete(root);
  // Release canceled queued nodes immediately, even if another root is loading a chunk.
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.owner === owner) queue.splice(i, 1);
}

/** Readiness means every diagram completed. Off-screen work waits for scrolling.
 * Print windows render all blocks before reporting readiness to the exporter. */
export function renderDiagrams(root: HTMLElement): Promise<void> {
  const existing = mountedByRoot.get(root);
  if (existing) return existing.ready;
  const nodes = [...root.querySelectorAll<HTMLElement>("pre.mermaid")];
  const owner: DiagramRoot = { jobs: new Set(), ready: Promise.resolve(), disposed: false };
  mountedByRoot.set(root, owner);
  const byNode = new Map<Element, Job>();
  if (typeof IntersectionObserver !== "undefined" && !document.body.classList.contains("print")) {
    owner.observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        const job = byNode.get(entry.target);
        if (job) enqueue(job);
      }
    }, { rootMargin: "600px 0px" });
  }
  owner.ready = Promise.all(nodes.map(node => new Promise<void>(resolve => {
    const job: Job = { node, source: node.textContent?.trim() ?? "", owner, root, queued: false,
      finish() { owner.jobs.delete(job); byNode.delete(node); resolve(); } };
    owner.jobs.add(job);
    byNode.set(node, job);
    if (owner.observer) owner.observer.observe(node);
    else enqueue(job);
  }))).then(() => { owner.observer?.disconnect(); });
  return owner.ready;
}
