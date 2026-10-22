# Linux file opening

Linux has no portable bare-Space preview hook or selected-file lookup in this app. Open a note through File > Open, the file manager's Open With menu, or a command with an explicit file path. Use one note per invocation.

## DEB packages

The package config generates a `simple-md.desktop` entry with `text/markdown` and `text/x-markdown` MIME types. Its unquoted `%f` argument passes one local file to the app. The Markdown file association includes `.md`, `.markdown`, `.mdown`, `.mkd`, and `.mdx`. Installing a package registers the handler. Choose Simple-md in your file manager's Open With menu; the app does not need to become the default.

Use the file manager's Properties or Open With controls if you want to change a default application. MIME handling varies by desktop and installed MIME database. Check `.mdx` separately because some systems associate it with another type.

## Portable AppImage or unpacked app

Keep the executable at a stable absolute path. For an AppImage, mark it executable first. The desktop-entry generator only prints text. It does not install files, change defaults, or enable autostart.

Run from `app/`, replacing the sample path with your own:

```sh
bun integrations/linux/desktop-entry.mjs "/absolute/path/Simple-md.AppImage" > /tmp/simple-md.desktop
```

Review the result. To register it for your user account yourself:

```sh
mkdir -p "${XDG_DATA_HOME:-$HOME/.local/share}/applications"
install -m 644 /tmp/simple-md.desktop "${XDG_DATA_HOME:-$HOME/.local/share}/applications/simple-md.desktop"
update-desktop-database "${XDG_DATA_HOME:-$HOME/.local/share}/applications"
```

`update-desktop-database` comes from `desktop-file-utils` on many distributions. If it is unavailable, use the desktop's application registration controls. This entry advertises Markdown MIME types but does not add new MIME extension definitions. A generic text association may require choosing the executable explicitly through Open With.

The generator quotes the executable path and escapes reserved characters according to the [desktop-entry Exec specification](https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html). It leaves `%f` outside quotes. Moving the AppImage requires regenerating the entry.

To remove this user registration, remove the `simple-md.desktop` file you created and refresh the desktop database. Package-managed registrations should be removed through the package manager.

## Shell launcher

`simple-md-open` forwards arguments without shell evaluation and clears `ELECTRON_RUN_AS_NODE` before launching Electron. It defaults to a `simple-md` executable on `PATH`. To use an AppImage or unpacked executable:

```sh
SIMPLE_MD_EXECUTABLE="/absolute/path/Simple-md.AppImage" \
  sh integrations/linux/simple-md-open "/absolute/path/note with spaces.md"
```

The launcher does not change associations or login settings. AppImage execution may require FUSE support, and Electron needs a working desktop session and sandbox support. Do not add `--no-sandbox` as a general installation step. File-manager integration, tray behavior, and X11 or Wayland shortcuts still need runtime checks on Linux.
