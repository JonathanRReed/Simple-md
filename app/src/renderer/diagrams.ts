import type { Mounted } from "pele/lazy";

type Pele = typeof import("pele/lazy");

let coreLoad: Promise<Pele> | undefined;
// Diagrams are owned by the container that rendered them, so the read view, split preview and live-editor widgets clean up independently.
const mountedByRoot = new WeakMap<Element, Pick<Mounted, "destroy">[]>();

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

export function destroyDiagrams(root: Element): void {
  for (const m of mountedByRoot.get(root) ?? []) m.destroy();
  mountedByRoot.delete(root);
}

// Each diagram type is its own chunk, so a note with one flowchart never loads the sequence-diagram layout.
export async function renderDiagrams(root: HTMLElement): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>("pre.mermaid")];
  const mounted = mountedByRoot.get(root) ?? [];
  mountedByRoot.set(root, mounted);
  await Promise.all(
    nodes.map(async (node) => {
      const source = node.textContent?.trim() ?? "";
      const fail = (message: string) => {
        if (node.isConnected) node.replaceWith(errorBlock(message, source));
      };

      let pele!: Pele;
      try {
        await Promise.all([loadCore().then((p) => (pele = p)), loadPurifier()]);
      } catch {
        return fail("The diagram renderer failed to load.");
      }

      let type: ReturnType<Pele["detectType"]> = null;
      try {
        type = pele.detectType(source);
      } catch {
        // Falls through to the unrecognized-type message.
      }
      if (!type) return fail("Unrecognized diagram type.");
      if (!(await pele.load(type).catch(() => false))) return fail("The diagram renderer failed to load.");
      if (!node.isConnected || mountedByRoot.get(root) !== mounted) return;

      const holder = document.createElement("div");
      holder.className = "diagram";
      const canvas = document.createElement("div");
      canvas.className = "diagram-canvas";
      const error = errorBlock("", source);
      error.hidden = true;
      holder.append(canvas, error);
      node.replaceWith(holder);

      let complete!: () => void;
      const ready = new Promise<void>((resolve) => { complete = resolve; });
      const instance = pele.mount(canvas, source, {
        links: false,
        images: false,
        zoom: false,
        autoDirection: false,
        sanitize: sanitizeSvg,
          onRender: () => {
            error.hidden = true;
            canvas.hidden = false;
            complete();
          },
          onError: (err) => {
            error.querySelector("p")!.textContent =
              `Unable to render diagram: ${err instanceof Error ? err.message : "The diagram could not be rendered."}`;
            error.hidden = false;
            canvas.hidden = true;
            complete();
          },
        });
      mounted.push({ destroy() { instance.destroy(); complete(); } });
      await ready;
    }),
  );
}
