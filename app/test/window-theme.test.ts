import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { watchWindowTheme } from "../src/main/window-theme";
test("closed windows release their theme listeners while other windows still update", () => {
  const theme = new EventEmitter(); const a = new EventEmitter(); const b = new EventEmitter();
  let updates = 0;
  const window = (events: EventEmitter) => Object.assign(events, { isDestroyed: () => false, setTitleBarOverlay: () => { updates++; } });
  const colors = () => ({ color: "black", symbolColor: "white", height: 38 });
  watchWindowTheme(theme, window(a), colors); watchWindowTheme(theme, window(b), colors);
  expect(theme.listenerCount("updated")).toBe(2);
  a.emit("closed"); expect(theme.listenerCount("updated")).toBe(1);
  theme.emit("updated"); expect(updates).toBe(1);
  b.emit("closed"); expect(theme.listenerCount("updated")).toBe(0);
});
