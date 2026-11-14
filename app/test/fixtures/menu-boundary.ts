import { expect, mock, test } from "bun:test";
import { updateMenu, type UpdateState } from "../../src/shared/update-state";
import type { MenuActions } from "../../src/main/menu";
import { DEFAULT_SETTINGS } from "../../src/shared/types";
import type { MenuItemConstructorOptions } from "electron";
let template: MenuItemConstructorOptions[] = [];
mock.module('electron', () => ({ app: { name: 'SimpleMD', isPackaged: false }, Menu: {
  buildFromTemplate(items: MenuItemConstructorOptions[]) { template = items; return items; }, setApplicationMenu() {},
} }));
const { buildMenu } = await import('../../src/main/menu');
test('Edit menu routes Find Next and Previous through app commands on every platform', () => {
  const commands: string[] = [];
  buildMenu({ settings: () => DEFAULT_SETTINGS, mode: () => 'read', changesStatus: () => ({ available: false, reason: '' }), command: command => commands.push(command),
    openDialog() {}, openPath() {}, patch() {}, clearRecents() {}, share() {}, hasDocumentPath: () => false, relativePath: () => false, canReopen: () => false, updateMenu: () => updateMenu({ kind: "idle" }, false), tabPinned: () => false, quit() {}, installCli() {}, checkUpdates() {}, installUpdate() {},
  } satisfies MenuActions);
  const edit = template.find(item => item.label === 'Edit')!.submenu;
  expect(Array.isArray(edit)).toBe(true);
  if (!Array.isArray(edit)) throw new Error('Missing Edit menu');
  const next = edit.find(item => item.label === 'Find Next')!, previous = edit.find(item => item.label === 'Find Previous')!;
  expect(next.accelerator).toBe('CommandOrControl+G'); expect(previous.accelerator).toBe('CommandOrControl+Shift+G');
  next.click?.({} as never, undefined, {} as never); previous.click?.({} as never, undefined, {} as never);
  expect(commands).toEqual(['find-next', 'find-previous']);
});

test("file, recovery, default-app and update menu items follow document and system state", () => {
  const platform = process.platform;
  try {
    for (const system of ["darwin", "win32", "linux"] as const) {
      Object.defineProperty(process, "platform", { value: system });
      let saved = false, relative = false, closed = false, downloaded = false;
      let state: UpdateState = { kind: "idle" };
      const commands: string[] = [];
      const actions: MenuActions = {
        settings: () => DEFAULT_SETTINGS, mode: () => "read", changesStatus: () => ({ available: false, reason: "" }), command: command => { commands.push(command); },
        openDialog() {}, openPath() {}, patch() {}, clearRecents() {}, share() {}, hasDocumentPath: () => saved, relativePath: () => relative, canReopen: () => closed,
        tabPinned: () => false, quit() {}, installCli() {}, checkUpdates() {}, installUpdate() {}, updateMenu: () => updateMenu(state, downloaded),
      };
      const entries = (label: string) => {
        const submenu = template.find(item => item.label === label)!.submenu;
        if (!Array.isArray(submenu)) throw new Error(`Missing ${label} menu`);
        return submenu;
      };
      buildMenu(actions);
      expect(entries("File").find(item => item.label === "Copy Path")?.enabled).toBe(false);
      expect(entries("File").find(item => item.label === "Rename or Move…")?.enabled).toBe(false);
      expect(entries("File").find(item => item.label === "Duplicate…")?.enabled).not.toBe(false);
      expect(entries("File").find(item => item.label === "Reopen Closed Tab")?.enabled).toBe(false);
      const appMenu = system === "darwin" ? "SimpleMD" : "Help";
      expect(entries(appMenu).find(item => item.label === "Restart to Install Update")?.enabled).toBe(false);
      saved = relative = closed = downloaded = true; state = { kind: "ready" }; buildMenu(actions);
      expect(entries("File").find(item => item.label === "Copy Path")?.enabled).toBe(true);
      expect(entries("File").find(item => item.label === "Copy Relative Path")?.enabled).toBe(true);
      const reopen = entries("File").find(item => item.label === "Reopen Closed Tab")!;
      expect(reopen.enabled).toBe(true); expect(reopen.accelerator).toBe("CommandOrControl+Shift+T");
      reopen.click?.({} as never, undefined, {} as never);
      entries(appMenu).find(item => item.label === "Make SimpleMD the Default Markdown App…")!.click?.({} as never, undefined, {} as never);
      expect(commands).toEqual(["reopen-closed-tab", "default-markdown-app"]);
      expect(entries(appMenu).find(item => item.label === "Restart to Install Update")?.enabled).toBe(true);
      expect(entries(appMenu).some(item => item.label?.includes("Ready to Install"))).toBe(true);
    }
  } finally { Object.defineProperty(process, "platform", { value: platform }); }
});
