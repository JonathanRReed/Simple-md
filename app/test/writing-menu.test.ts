import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { commandDefinitions, paletteCommand, writingCommand } from "../src/shared/commands";
import { DEFAULT_SETTINGS } from "../src/shared/types";
import { htmlToMarkdown } from "../src/shared/html-to-markdown";

interface Item { id?: string; label?: string; role?: string; enabled?: boolean; submenu?: { items: Item[] } }
async function menuModule() {
  const file = new URL('../src/main/menu.ts', import.meta.url);
  const source = (await Bun.file(file).text()).replace(/\r\n/g, "\n");
  const built = await Bun.build({ entrypoints: [fileURLToPath(file)], target: "bun", plugins: [{ name: "menu-without-electron", setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "test" }));
    build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: `
      export const app = { name: 'SimpleMD', isPackaged: false };
      export class Menu {
        static current;
        static buildFromTemplate(items) { return { items: items.map(item => ({ ...item, submenu: Array.isArray(item.submenu) ? Menu.buildFromTemplate(item.submenu) : item.submenu })) }; }
        static setApplicationMenu(menu) { Menu.current = menu; }
      }`, loader: "js" }));
    build.onLoad({ filter: /[\\/]main[\\/]menu\.ts$/ }, () => ({ contents: source + '\nexport { Menu as TestMenu };', loader: "ts" }));
  } }] });
  expect(built.success).toBe(true);
  return import('data:text/javascript;base64,' + Buffer.from(await built.outputs[0]!.text()).toString('base64'));
}
const mainSource = async () => (await Bun.file(new URL('../src/main/main.ts', import.meta.url)).text()).replace(/\r\n/g, "\n");

test("native labels come from shared definitions and retain dynamic labels", async () => {
  const { buildMenu, TestMenu } = await menuModule();
  buildMenu({ settings: () => DEFAULT_SETTINGS, mode: () => 'source', changesStatus: () => ({ available: false, reason: 'No file' }),
    command() {}, hasDocumentPath: () => true, tabPinned: () => true, relativePath: () => false, canReopen: () => true,
    updateMenu: () => ({ checkLabel: 'Check for Updates: Up to Date', checkEnabled: true, installEnabled: false }) });
  const items: Item[] = [];
  const visit = (menu: { items: Item[] }) => { for (const item of menu.items) { items.push(item); if (item.submenu) visit(item.submenu); } };
  visit(TestMenu.current);
  for (const item of items) {
    if (!item.id || item.role || ['toggle-pin-tab', 'toggle-tab-sidebar', 'quit', 'check-updates'].includes(item.id)) continue;
    const definition = commandDefinitions.find(command => command.id === item.id);
    if (definition) expect(item.label).toBe(process.platform === 'darwin' ? definition.macLabel ?? definition.label : definition.label);
  }
  expect(items.find(item => item.id === 'toggle-pin-tab')?.label).toBe('Unpin Tab');
  expect(items.find(item => item.id === 'check-updates')?.label).toBe('Check for Updates: Up to Date');
});

test("writing menu items use the existing document and pane state", async () => {
  const source = await mainSource(), start = source.indexOf('function refreshWritingMenu(): void {');
  const body = source.slice(start, source.indexOf('\n}', start) + 2).replace('(): void', '()');
  const items = new Map(commandDefinitions.map(command => [command.id, { enabled: true }]));
  const doc = { readOnlyReason: null as string | null };
  const paneModes = new Map([[0, 'read']]);
  const refresh = new Function('registry', 'frontmost', 'Menu', 'commandDefinitions', 'writingCommand', 'writingContexts', `${body}; return refreshWritingMenu;`)(
    { get: () => doc }, { mainPane: { documentId: 1, paneId: 0 }, paneModes }, { getApplicationMenu: () => ({ getMenuItemById: (id: string) => items.get(id) }) }, commandDefinitions, writingCommand, new WeakMap());
  for (const [mode, readonly] of [['read', false], ['live', false], ['source', true], ['split', false]] satisfies [string, boolean][]) {
    paneModes.set(0, mode); doc.readOnlyReason = readonly ? 'Locked' : null; refresh();
    for (const command of commandDefinitions.filter(command => writingCommand(command.id))) expect(items.get(command.id)?.enabled).toBe(mode !== 'read' && !readonly);
  }
});

test("palette excludes system roles and keeps writing and table commands", () => {
  for (const id of ['cut', 'copy', 'paste', 'selectAll', 'minimize', 'zoom', 'front', 'togglefullscreen', 'toggleDevTools', 'hide', 'about']) expect(paletteCommand(id)).toBe(false);
  for (const id of ['format-bold', 'toggle-task', 'table-row-up', 'table-align-center', 'insert-image', 'paste-markdown', 'fold']) { expect(writingCommand(id)).toBe(true); expect(paletteCommand(id)).toBe(true); }
});

test("Paste as Markdown returns converted text only for the active writable editor", async () => {
  const source = await mainSource();
  expect(source).not.toContain('"smd:clipboard-html"');
  const start = source.indexOf('handle("smd:paste-markdown", ');
  const callback = source.slice(start + 'handle("smd:paste-markdown", '.length, source.indexOf('\n  });', start) + 4)
    .replace('    const { htmlToMarkdown } = await import("../shared/html-to-markdown.js");\n', '');
  const doc = { readOnlyReason: null as string | null };
  const modes = new Map([[0, 'read']]);
  let reads = 0;
  const paste = new Function('ipcSession', 'context', 'currentSession', 'clipboard', 'htmlToMarkdown', `return ${callback};`)(
    () => doc, () => ({ mainPane: { paneId: 0 }, paneModes: modes }), () => doc,
    { read: async () => { reads++; return [{ types: ['text/html'], getType: async () => new Blob(['<head><title>Junk</title></head><p>1. text</p>']) }]; } }, htmlToMarkdown);
  expect(await paste(1)).toBe(''); expect(reads).toBe(0);
  modes.set(0, 'live'); doc.readOnlyReason = 'Locked';
  expect(await paste(1)).toBe(''); expect(reads).toBe(0);
  doc.readOnlyReason = null;
  expect(await paste(1)).toBe('1\\. text'); expect(reads).toBe(1);
});
