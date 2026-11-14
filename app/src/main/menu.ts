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
  quit(): void;
  installCli(): void;
  checkUpdates(): void;
  installUpdate(): void;
}

export function buildMenu(a: MenuActions): void {
  const s = a.settings();
  const changes = changesMenuState(a.hasDocumentPath(), a.changesStatus());
  const mac = process.platform === "darwin";
  const cmd = (label: string, command: Command, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    enabled: !commandDefinition(command)?.table,
    id: command,
    accelerator: commandDefinition(command) ? commandAccelerator(commandDefinition(command)!, mac) : accelerator,
    click: () => a.command(command),
  });
  const radio = <T extends string>(label: string, current: T, value: T, set: (v: T) => void, accelerator?: string): MenuItemConstructorOptions => ({
    id: label === "System" || label === "Light" || label === "Dark" ? `appearance-${value}` : `mode-${value}`,
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
        { id: "clear-recents", label: "Clear Menu", click: a.clearRecents },
      ]
    : [{ label: "No Recent Files", enabled: false }];

  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { id: "about", role: "about" },
              { id: "check-updates", label: "Check for Updates…", click: a.checkUpdates },
              { id: "install-update", label: "Restart to Install Update…", click: a.installUpdate },
              { type: "separator" },
              cmd("Settings…", "preferences"),
              { id: "install-cli", label: "Install Command Line Tool", click: a.installCli },
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
        cmd("New", "new"),
        { ...cmd("New", "new"), id: "new-tab", accelerator: commandAccelerator(commandDefinition("new-tab")!, mac) },
        { id: "open", label: "Open…", accelerator: "CommandOrControl+O", click: a.openDialog },
        cmd("Open Quickly…", "open-quickly"),
        { label: "Open Recent", submenu: recents },
        { type: "separator" },
        cmd("Save", "save"),
        cmd("Save As…", "save-as"),
        { type: "separator" },
        ...(mac ? [{ id: "share", label: "Share", enabled: a.hasDocumentPath(), click: a.share } satisfies MenuItemConstructorOptions] : []),
        cmd("Export as PDF…", "export-pdf"),
        cmd("Export as HTML…", "export-html"),
        cmd("Print…", "print"),
        cmd(mac ? "Reveal in Finder" : "Show in File Manager", "reveal"),
        { type: "separator" },
        cmd("Close Tab", "close-tab"),
        cmd("Move Tab to New Window", "move-tab-window"),
        ...(mac ? [] : [cmd("Settings…", "preferences"), { type: "separator" } satisfies MenuItemConstructorOptions]),
        ...(mac ? [] : [{ id: "quit", label: "Quit", accelerator: "Ctrl+Q", click: a.quit } satisfies MenuItemConstructorOptions]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        cmd("Undo", "undo"),
        cmd("Redo", "redo"),
        { type: "separator" },
        { id: "cut", role: "cut" },
        { id: "copy", role: "copy" },
        { id: "paste", role: "paste" },
        { id: "selectAll", role: "selectAll" },
        { type: "separator" },
        cmd("Find…", "find"),
        cmd("Find Next", "find-next"),
        cmd("Find Previous", "find-previous"),
        ...(mac ? [cmd("Use Selection for Find", "use-selection-find")] : []),
        { type: "separator" },
        cmd("Find and Replace…", "find-replace"),
        cmd("Go to Line…", "go-to-line"),
        { label: "Copy As", submenu: [cmd("Copy as Markdown", "copy-markdown"), cmd("Copy as HTML", "copy-html"), cmd("Copy Formatted", "copy-formatted")] },
        cmd("Paste as Markdown", "paste-markdown"),
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
        cmd("Bold", "format-bold"),
        cmd("Italic", "format-italic"),
        cmd("Strikethrough", "format-strike"),
        cmd("Code", "format-code"),
        cmd("Link", "format-link"),
        { type: "separator" },
        cmd("Heading 1", "block-heading-1"),
        cmd("Heading 2", "block-heading-2"),
        cmd("Heading 3", "block-heading-3"),
        cmd("Heading 4", "block-heading-4"),
        cmd("Heading 5", "block-heading-5"),
        cmd("Heading 6", "block-heading-6"),
        cmd("Body", "block-body"),
        cmd("Bulleted List", "block-bullet-list"),
        cmd("Numbered List", "block-number-list"),
        cmd("Task List", "block-task-list"),
        cmd("Block Quote", "block-quote"),
        cmd("Code Block", "block-code-block"),
        cmd("Horizontal Rule", "block-rule"),
        cmd("Insert Footnote", "block-footnote"),
        cmd("Toggle Task", "toggle-task"),
        { type: "separator" },
        cmd("Insert Image…", "insert-image"),
        { label: "Table", submenu: [
          cmd("Add Row Above", "table-row-above"),
          cmd("Add Row Below", "table-row-below"),
          cmd("Add Column Left", "table-column-left"),
          cmd("Add Column Right", "table-column-right"),
          cmd("Delete Row", "table-delete-row"),
          cmd("Delete Column", "table-delete-column"),
          cmd("Move Row Up", "table-row-up"),
          cmd("Move Row Down", "table-row-down"),
          cmd("Align Left", "table-align-left"),
          cmd("Align Center", "table-align-center"),
          cmd("Align Right", "table-align-right"),
          cmd("No Alignment", "table-align-none"),
          cmd("Insert Table", "table-insert-table"),
        ] },
      ] },
    {
      label: "View",
      submenu: [
        { ...cmd("Zen Mode", "toggle-zen"), type: "checkbox", checked: s.zenMode },
        { ...cmd(a.tabPinned() ? "Unpin Tab" : "Pin Tab", "toggle-pin-tab"), enabled: a.hasDocumentPath() },
        { ...cmd("Close Pinned Tab", "close-pinned-tab"), enabled: a.tabPinned() },
        cmd(s.tabStyle === "sidebar" && !s.sidebarCollapsed ? "Hide Tab Sidebar" : "Show Tab Sidebar", "toggle-tab-sidebar"),
        cmd("Split Side by Side", "split-panes"),
        cmd("Split Stacked", "stack-panes"),
        cmd("Focus Other Pane", "focus-pane"),
        cmd("Next Tab", "next-tab"),
        cmd("Previous Tab", "previous-tab"),
        { id: "toggle-head-changes", label: "Show Changes Since Last Commit", type: "checkbox", ...changes, click: item => { item.checked = changes.checked; a.command("toggle-head-changes"); } },
        cmd("Mark Seen", "mark-seen"),
        cmd("Next Change", "next-change"),
        cmd("Previous Change", "previous-change"),
        { type: "separator" },
        cmd("Read / Edit", "toggle-edit"),
        cmd("Read", "mode-read"),
        cmd("Back", "nav-back"),
        cmd("Forward", "nav-forward"),
        { type: "separator" },
        {
          label: "Document Mode",
          submenu: (["live", "split", "source"] as const).map((m) =>
            radio<ViewMode>(
              { live: "Live Preview", split: "Side by side", source: "Source" }[m],
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
            radio<ThemeSetting>({ system: "System", light: "Light", dark: "Dark" }[t], s.theme, t, (v) => a.patch({ theme: v })),
          ),
        },
        {
          id: "github-style", label: "GitHub Style", type: "checkbox", checked: s.readingStyle === "github",
          click: () => a.patch({ readingStyle: s.readingStyle === "github" ? "editorial" : "github" }),
        },
        { type: "separator" },
        cmd("Zoom In", "zoom-in"),
        cmd("Zoom Out", "zoom-out"),
        cmd("Actual Size", "zoom-reset"),
        { type: "separator" },
        ...["fold", "unfold", "fold-all", "unfold-all"].map(id => cmd(commandDefinition(id)!.label, id as Command)),
        cmd("Outline", "outline"),
        cmd("Command Palette…", "palette"),
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
    { label: "Window", submenu: [{ id: "minimize", role: "minimize" }, { id: "zoom", role: "zoom" }, { id: "front", role: "front" }] },
    ...(mac ? [] : [{ label: "Help", submenu: [
      { id: "check-updates", label: "Check for Updates…", click: a.checkUpdates },
      { id: "install-update", label: "Restart to Install Update…", click: a.installUpdate },
    ] } satisfies MenuItemConstructorOptions]),
  ];

  const bind = (items: MenuItemConstructorOptions[]): void => {
    for (const item of items) {
      const definition = item.id ? commandDefinition(item.id) : undefined;
      if (definition) {
        item.accelerator = commandAccelerator(definition, mac);
        if (!["toggle-pin-tab", "toggle-tab-sidebar", "quit"].includes(definition.id)) item.label = mac ? definition.macLabel ?? definition.label : definition.label;
      }
      if (Array.isArray(item.submenu)) bind(item.submenu);
    }
  };
  bind(template);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
