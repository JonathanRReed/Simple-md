import type { GitChangesStatus } from "../shared/change-highlights.js";
import { changesMenuState } from "./menu-state.js";
import path from "node:path";
import { Menu, app, type MenuItemConstructorOptions } from "electron";
import type { Command, EditMode, Settings, ThemeSetting } from "../shared/types.js";

export interface MenuActions {
  settings(): Settings;
  changesStatus(): GitChangesStatus;
  command(cmd: Command): void;
  openDialog(): void;
  openPath(file: string): void;
  patch(patch: Partial<Settings>): void;
  clearRecents(): void;
  share(): void;
  hasDocumentPath(): boolean;
  quit(): void;
  installCli(): void;
}

export function buildMenu(a: MenuActions): void {
  const s = a.settings();
  const changes = changesMenuState(a.hasDocumentPath(), a.changesStatus());
  const mac = process.platform === "darwin";
  const cmd = (label: string, command: Command, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => a.command(command),
  });
  const radio = <T extends string>(label: string, current: T, value: T, set: (v: T) => void, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    type: "radio",
    checked: current === value,
    accelerator,
    click: () => set(value),
  });

  const recents: MenuItemConstructorOptions[] = s.recents.length
    ? [
        ...s.recents.map((p): MenuItemConstructorOptions => ({ label: path.basename(p), sublabel: path.dirname(p), click: () => a.openPath(p) })),
        { type: "separator" },
        { label: "Clear Menu", click: a.clearRecents },
      ]
    : [{ label: "No Recent Files", enabled: false }];

  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              cmd("Settings…", "preferences", "Command+,"),
              { label: "Install Command Line Tool", click: a.installCli },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { label: `Quit ${app.name}`, accelerator: "Command+Q", click: a.quit },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        cmd("New", "new", "CommandOrControl+N"),
        cmd("New Tab", "new", "CommandOrControl+T"),
        { label: "Open…", accelerator: "CommandOrControl+O", click: a.openDialog },
        { label: "Open Recent", submenu: recents },
        { type: "separator" },
        cmd("Save", "save", "CommandOrControl+S"),
        cmd("Save As…", "save-as", "CommandOrControl+Shift+S"),
        { type: "separator" },
        ...(mac ? [{ label: "Share", enabled: a.hasDocumentPath(), click: a.share } satisfies MenuItemConstructorOptions] : []),
        cmd("Export as PDF…", "export-pdf"),
        cmd("Export as HTML…", "export-html"),
        cmd("Print…", "print", "CommandOrControl+P"),
        cmd(mac ? "Reveal in Finder" : "Show in File Manager", "reveal"),
        { type: "separator" },
        cmd("Close Tab", "close-tab", "CommandOrControl+W"),
        cmd("Move Tab to New Window", "move-tab-window"),
        ...(mac ? [] : [cmd("Settings…", "preferences", "Control+,"), { type: "separator" } satisfies MenuItemConstructorOptions]),
        ...(mac ? [] : [{ label: "Quit", accelerator: "Ctrl+Q", click: a.quit } satisfies MenuItemConstructorOptions]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        cmd("Undo", "undo", "CommandOrControl+Z"),
        cmd("Redo", "redo", "CommandOrControl+Shift+Z"),
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        cmd("Find…", "find", "CommandOrControl+F"),
        ...(mac ? [cmd("Use Selection for Find", "use-selection-find", "Command+E")] : []),
        { type: "separator" },
        cmd("Bold", "format-bold", "CommandOrControl+B"),
        cmd("Italic", "format-italic", "CommandOrControl+I"),
        cmd("Strikethrough", "format-strike", "CommandOrControl+Shift+X"),
        cmd("Code", "format-code", mac ? undefined : "Control+E"),
        cmd("Link", "format-link", "CommandOrControl+K"),
        { type: "separator" },
        {
          label: "Spelling and Grammar",
          type: "checkbox",
          checked: s.spellcheck,
          click: () => a.patch({ spellcheck: !s.spellcheck }),
        },
        {
          label: "Vim Mode",
          type: "checkbox",
          checked: s.vim,
          click: () => a.patch({ vim: !s.vim }),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        cmd("Split Side by Side", "split-panes", "CommandOrControl+\\"),
        cmd("Split Stacked", "stack-panes", "CommandOrControl+Shift+\\"),
        cmd("Focus Other Pane", "focus-pane", "CommandOrControl+Alt+Right"),
        cmd("Next Tab", "next-tab", "CommandOrControl+Shift+]"),
        cmd("Previous Tab", "previous-tab", "CommandOrControl+Shift+["),
        { label: "Show Changes Since Last Commit", type: "checkbox", ...changes, click: item => { item.checked = changes.checked; a.command("toggle-head-changes"); } },
        cmd("Mark Seen", "mark-seen", "CommandOrControl+Shift+M"),
        cmd("Next Change", "next-change", "CommandOrControl+Alt+Down"),
        cmd("Previous Change", "previous-change", "CommandOrControl+Alt+Up"),
        { type: "separator" },
        cmd("Read / Edit", "toggle-edit", "CommandOrControl+Return"),
        cmd("Back", "nav-back", mac ? "Cmd+[" : "Alt+Left"),
        cmd("Forward", "nav-forward", mac ? "Cmd+]" : "Alt+Right"),
        { type: "separator" },
        {
          label: "Editing Mode",
          submenu: (["live", "split", "source"] as const).map((m, i) =>
            radio<EditMode>(
              { live: "Live Preview", split: "Side by side", source: "Source" }[m],
              s.mode,
              m,
              (v) => a.command(v === "live" ? "mode-live" : v === "source" ? "mode-source" : "mode-split"),
              `CommandOrControl+Alt+${i + 1}`,
            ),
          ),
        },
        { type: "separator" },
        {
          label: "Appearance",
          submenu: (["system", "light", "dark"] as const).map((t) =>
            radio<ThemeSetting>({ system: "System", light: "Light", dark: "Dark" }[t], s.theme, t, (v) => a.patch({ theme: v })),
          ),
        },
        {
          label: "GitHub Style", type: "checkbox", checked: s.readingStyle === "github",
          click: () => a.patch({ readingStyle: s.readingStyle === "github" ? "editorial" : "github" }),
        },
        { type: "separator" },
        cmd("Zoom In", "zoom-in", "CommandOrControl+="),
        cmd("Zoom Out", "zoom-out", "CommandOrControl+-"),
        cmd("Actual Size", "zoom-reset", "CommandOrControl+0"),
        { type: "separator" },
        cmd("Outline", "outline", "CommandOrControl+Shift+O"),
        cmd("Command Palette…", "palette", "CommandOrControl+Shift+P"),
        { type: "separator" },
        {
          label: "Autosave",
          type: "checkbox",
          checked: s.autosave,
          click: () => a.patch({ autosave: !s.autosave }),
        },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" } satisfies MenuItemConstructorOptions]),
      ],
    },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
