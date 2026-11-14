import { expect, mock, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../../src/shared/types";
import type { MenuItemConstructorOptions } from "electron";
let template: MenuItemConstructorOptions[] = [];
mock.module('electron', () => ({ app: { name: 'SimpleMD', isPackaged: false }, Menu: {
  buildFromTemplate(items: MenuItemConstructorOptions[]) {
    template = items;
    function native(entries: MenuItemConstructorOptions[]): { items: unknown[] } {
      return { items: entries.map(item => ({ ...item, submenu: Array.isArray(item.submenu) ? native(item.submenu) : item.submenu })) };
    }
    return native(items);
  }, setApplicationMenu() {},
} }));
const { buildMenu } = await import('../../src/main/menu');
test('Edit menu routes Find Next and Previous through app commands on every platform', () => {
  const commands: string[] = [];
  buildMenu({ settings: () => DEFAULT_SETTINGS, mode: () => 'read', changesStatus: () => ({ available: false, reason: '' }), command: command => commands.push(command),
    openDialog() {}, openPath() {}, patch() {}, clearRecents() {}, share() {}, hasDocumentPath: () => false, tabPinned: () => false, quit() {}, installCli() {}, checkUpdates() {}, installUpdate() {},
  });
  const edit = template.find(item => item.label === 'Edit')!.submenu;
  expect(Array.isArray(edit)).toBe(true);
  if (!Array.isArray(edit)) throw new Error('Missing Edit menu');
  const next = edit.find(item => item.label === 'Find Next')!, previous = edit.find(item => item.label === 'Find Previous')!;
  expect(next.accelerator).toBe('CommandOrControl+G'); expect(previous.accelerator).toBe('CommandOrControl+Shift+G');
  next.click?.({} as never, undefined, {} as never); previous.click?.({} as never, undefined, {} as never);
  expect(commands).toEqual(['find-next', 'find-previous']);
});
