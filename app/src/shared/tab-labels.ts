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
