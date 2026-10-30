/** Keep the file's ending visible and let the start take the ellipsis, Finder style. */
export function splitTabLabel(label: string, tail = 7): [string, string] {
  if (label.length <= tail + 3) return [label, ""];
  return [label.slice(0, -tail), label.slice(-tail)];
}

export interface TabName { name: string; path: string | null }

export function tabLabel(tab: TabName, tabs: TabName[]): string {
  const peers = tabs.filter(other => other.name === tab.name);
  if (peers.length < 2 || !tab.path) return tab.name;
  const folders = (file: string) => file.split(/[\\/]/).slice(0, -1);
  const parts = folders(tab.path);
  for (let depth = 1; depth <= parts.length; depth++) {
    const suffix = parts.slice(-depth).join("/");
    if (peers.every(other => other === tab || other.path === tab.path || !other.path || folders(other.path).slice(-depth).join("/") !== suffix)) return `${tab.name} · ${suffix}`;
  }
  return `${tab.name} · ${parts.join("/")}`;
}

/** Short filenames stay readable; long shared prefixes fall back to numbered fragments. */
export function pinnedTabLabels(labels: string[]): string[] {
  const stems = labels.map(label => label.replace(/\.(?:md|mdx|markdown|mdown|mkd)(?= · |$)/i, ""));
  return stems.map((stem, index) => {
    for (let length = Math.min(3, stem.length); length <= 6; length++) {
      const fragment = Array.from(stem).slice(0, length).join("");
      if (/[_ .-]$/.test(fragment) && fragment.length < stem.length) continue;
      if (stems.every((other, peer) => peer === index || Array.from(other).slice(0, length).join("").toLocaleLowerCase() !== fragment.toLocaleLowerCase())) return fragment;
    }
    return `${Array.from(stem).slice(0, 3).join("")}·${index + 1}`;
  });
}
