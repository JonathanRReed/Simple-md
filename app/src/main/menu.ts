import { commandDefinition, commandAccelerator } from "../shared/commands.js";
import type { GitChangesStatus } from "../shared/change-highlights.js";
import { changesMenuState } from "./menu-state.js";
import path from "node:path";
import { Menu, app, type MenuItemConstructorOptions } from "electron";
import type { Command, ViewMode, Settings, ThemeSetting } from "../shared/types.js";

export interface MenuActions {
  settings(): Settings;
  mode(): ViewMode;
  changesStatus(): GitChangesStatus;
  command(cmd: Command): void;
  openDialog(): void;
  openPath(file: string): void;
  patch(patch: Partial<Settings>): void;
  clearRecents(): void;
  share(): void;
  hasDocumentPath(): boolean;
  tabPinned(): boolean;
  relativePath(): boolean;
  canReopen(): boolean;
  quit(): void;
  installCli(): void;
  checkUpdates(): void;
  installUpdate(): void;
  updateMenu(): ReturnType<typeof import("../shared/update-state.js").updateMenu>;
}

export function buildMenu(a: MenuActions): void {
  const s = a.settings();
  const update = a.updateMenu();
  const changes = changesMenuState(a.hasDocumentPath(), a.changesStatus());
  const mac = process.platform === "darwin";
  const cmd = (command: Command | "new-tab", label?: string): MenuItemConstructorOptions => {
    const definition = commandDefinition(command)!;
    return { label: label ?? (mac ? definition.macLabel ?? definition.label : definition.label),
      id: command, accelerator: commandAccelerator(definition, mac), click: () => a.command(command === "new-tab" ? "new" : command) };
  };
  const radio = <T extends string>(id: string, current: T, value: T, set: (v: T) => void, accelerator?: string): MenuItemConstructorOptions => ({
    id,
    label: commandDefinition(id)!.label,
    type: "radio",
    checked: current === value,
    accelerator,
    click: () => set(value),
  });

  const recents: MenuItemConstructorOptions[] = s.recents.length
    ? [
        ...s.recents.map((p): MenuItemConstructorOptions => ({ label: path.basename(p), sublabel: path.dirname(p), click: () => a.openPath(p) })),
        { type: "separator" },
        { id: "clear-recents", click: a.clearRecents },
      ]
    : [{ label: "No Recent Files", enabled: false }, { type: "separator" }, { label: "Clear Menu", click: a.clearRecents }];

  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { id: "about", role: "about" },
              { id: "check-updates", label: update.checkLabel, enabled: update.checkEnabled, click: a.checkUpdates },
              { id: "install-update", enabled: update.installEnabled, click: a.installUpdate },
              { type: "separator" },
              cmd("preferences"),
              { id: "install-cli", click: a.installCli },
              cmd("default-markdown-app"),
              { type: "separator" },
              { id: "hide", role: "hide" },
              { id: "hideOthers", role: "hideOthers" },
              { id: "unhide", role: "unhide" },
              { type: "separator" },
              { id: "quit", label: `Quit ${app.name}`, accelerator: "Command+Q", click: a.quit },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        cmd("new"),
        cmd("new-tab"),
        { id: "open", accelerator: "CommandOrControl+O", click: a.openDialog },
        cmd("open-quickly"),
        { label: "Open Recent", submenu: recents },
        { type: "separator" },
        cmd("save"),
        cmd("save-as"),
        { ...cmd("copy-path"), enabled: a.hasDocumentPath() },
        { ...cmd("copy-relative-path"), enabled: a.relativePath() },
        cmd("duplicate-file"),
        { ...cmd("rename-move"), enabled: a.hasDocumentPath() },
        { ...cmd("reopen-closed-tab"), enabled: a.canReopen() },
        { type: "separator" },
        ...(mac ? [{ id: "share", enabled: a.hasDocumentPath(), click: a.share } satisfies MenuItemConstructorOptions] : []),
        cmd("export-pdf"),
        cmd("export-html"),
        cmd("print"),
        cmd("reveal"),
        { type: "separator" },
        cmd("close-tab"),
        cmd("move-tab-window"),
        ...(mac ? [] : [cmd("preferences"), { type: "separator" } satisfies MenuItemConstructorOptions]),
        ...(mac ? [] : [{ id: "quit", label: "Quit", accelerator: "Ctrl+Q", click: a.quit } satisfies MenuItemConstructorOptions]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        cmd("undo"),
        cmd("redo"),
        { type: "separator" },
        { id: "cut", role: "cut" },
        { id: "copy", role: "copy" },
        { id: "paste", role: "paste" },
        { id: "selectAll", role: "selectAll" },
        { type: "separator" },
        cmd("find"),
        cmd("find-next"),
        cmd("find-previous"),
        ...(mac ? [cmd("use-selection-find")] : []),
        { type: "separator" },
        cmd("find-replace"),
        cmd("go-to-line"),
        { label: "Copy As", submenu: [cmd("copy-markdown"), cmd("copy-html"), cmd("copy-formatted")] },
        cmd("paste-markdown"),
        { type: "separator" },
        {
          id: "spelling", label: "Spelling and Grammar",
          type: "checkbox",
          checked: s.spellcheck,
          click: () => a.patch({ spellcheck: !s.spellcheck }),
        },
        {
          id: "vim", label: "Vim Mode",
          type: "checkbox",
          checked: s.vim,
          click: () => a.patch({ vim: !s.vim }),
        },
      ],
    },
    // Writing commands stay together for the files-tabs integration.
    { label: "Format", submenu: [
        cmd("format-bold"),
        cmd("format-italic"),
        cmd("format-strike"),
        cmd("format-code"),
        cmd("format-link"),
        { type: "separator" },
        cmd("block-heading-1"),
        cmd("block-heading-2"),
        cmd("block-heading-3"),
        cmd("block-heading-4"),
        cmd("block-heading-5"),
        cmd("block-heading-6"),
        cmd("block-body"),
        cmd("block-bullet-list"),
        cmd("block-number-list"),
        cmd("block-task-list"),
        cmd("block-quote"),
        cmd("block-code-block"),
        cmd("block-rule"),
        cmd("block-footnote"),
        cmd("toggle-task"),
        { type: "separator" },
        cmd("insert-image"),
        { label: "Table", submenu: [
          cmd("table-row-above"),
          cmd("table-row-below"),
          cmd("table-column-left"),
          cmd("table-column-right"),
          cmd("table-delete-row"),
          cmd("table-delete-column"),
          cmd("table-row-up"),
          cmd("table-row-down"),
          cmd("table-align-left"),
          cmd("table-align-center"),
          cmd("table-align-right"),
          cmd("table-align-none"),
          cmd("table-insert-table"),
        ] },
      ] },
    {
      label: "View",
      submenu: [
        { ...cmd("toggle-zen"), type: "checkbox", checked: s.zenMode },
        { ...cmd("toggle-pin-tab", a.tabPinned() ? "Unpin Tab" : "Pin Tab"), enabled: a.hasDocumentPath() },
        { ...cmd("close-pinned-tab"), enabled: a.tabPinned() },
        cmd("toggle-tab-sidebar", s.tabStyle === "sidebar" && !s.sidebarCollapsed ? "Hide Tab Sidebar" : "Show Tab Sidebar"),
        cmd("split-panes"),
        cmd("stack-panes"),
        cmd("focus-pane"),
        cmd("next-tab"),
        cmd("previous-tab"),
        { id: "toggle-head-changes", type: "checkbox", ...changes, click: item => { item.checked = changes.checked; a.command("toggle-head-changes"); } },
        cmd("mark-seen"),
        cmd("next-change"),
        cmd("previous-change"),
        { type: "separator" },
        cmd("toggle-edit"),
        cmd("mode-read"),
        cmd("nav-back"),
        cmd("nav-forward"),
        { type: "separator" },
        {
          label: "Document Mode",
          submenu: (["live", "split", "source"] as const).map((m) =>
            radio<ViewMode>(
              `mode-${m}`,
              a.mode(),
              m,
              (v) => a.command(v === "live" ? "mode-live" : v === "source" ? "mode-source" : "mode-split"),
              commandAccelerator(commandDefinition(`mode-${m}`)!, mac),
            ),
          ),
        },
        { type: "separator" },
        {
          label: "Appearance",
          submenu: (["system", "light", "dark"] as const).map((t) =>
            radio<ThemeSetting>(`appearance-${t}`, s.theme, t, (v) => a.patch({ theme: v })),
          ),
        },
        {
          id: "github-style", type: "checkbox", checked: s.readingStyle === "github",
          click: () => a.patch({ readingStyle: s.readingStyle === "github" ? "editorial" : "github" }),
        },
        { type: "separator" },
        cmd("zoom-in"),
        cmd("zoom-out"),
        cmd("zoom-reset"),
        { type: "separator" },
        ...["fold", "unfold", "fold-all", "unfold-all"].map(id => cmd(id as Command)),
        cmd("outline"),
        cmd("palette"),
        { type: "separator" },
        {
          id: "autosave", label: "Autosave",
          type: "checkbox",
          checked: s.autosave,
          click: () => a.patch({ autosave: !s.autosave }),
        },
        { id: "togglefullscreen", role: "togglefullscreen" },
        ...(app.isPackaged ? [] : [{ id: "toggleDevTools", role: "toggleDevTools" } satisfies MenuItemConstructorOptions]),
      ],
    },
    { role: "windowMenu" },
    ...(mac ? [] : [{ label: "Help", submenu: [
      cmd("default-markdown-app"),
      { id: "check-updates", label: update.checkLabel, enabled: update.checkEnabled, click: a.checkUpdates },
      { id: "install-update", enabled: update.installEnabled, click: a.installUpdate },
    ] } satisfies MenuItemConstructorOptions]),
  ];

  const bind = (items: MenuItemConstructorOptions[]): void => {
    for (const item of items) {
      const definition = item.id ? commandDefinition(item.id) : undefined;
      if (definition) {
        item.accelerator = commandAccelerator(definition, mac);
        if (!["toggle-pin-tab", "toggle-tab-sidebar", "quit", "check-updates"].includes(definition.id)) item.label = mac ? definition.macLabel ?? definition.label : definition.label;
      }
      if (Array.isArray(item.submenu)) bind(item.submenu);
    }
  };
  bind(template);
  const menu = Menu.buildFromTemplate(template);
  const indexRoles = (native: Menu): void => {
    for (const item of native.items) {
      if (!item.id && item.role && commandDefinition(item.role)) item.id = item.role;
      if (item.submenu) indexRoles(item.submenu);
    }
  };
  indexRoles(menu);
  Menu.setApplicationMenu(menu);
}
