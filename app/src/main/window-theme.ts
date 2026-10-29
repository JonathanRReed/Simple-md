interface ThemeEvents {
  on(event: "updated", listener: () => void): unknown;
  removeListener(event: "updated", listener: () => void): unknown;
}
interface ThemeWindow {
  once(event: "closed", listener: () => void): unknown;
  isDestroyed(): boolean;
  setTitleBarOverlay(colors: { color: string; symbolColor: string; height: number }): void;
}
export function watchWindowTheme(theme: ThemeEvents, win: ThemeWindow, colors: () => { color: string; symbolColor: string; height: number }): void {
  const update = () => { if (!win.isDestroyed()) win.setTitleBarOverlay(colors()); };
  theme.on("updated", update);
  win.once("closed", () => theme.removeListener("updated", update));
}
