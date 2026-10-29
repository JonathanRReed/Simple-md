# Raycast script command

Install the SimpleMD CLI, then add this directory to Raycast's Script Commands directories. Run Open in SimpleMD and enter a file path, optionally followed by `:42` or `#heading`.

The script runs `simplemd -- "$1"`. Raycast must have the CLI directory in its PATH. If needed, replace `simplemd` in the script with its absolute installed path. Relative paths resolve against Raycast's working directory, so use absolute paths.

This is a shell script command, not an extension package. See [CLI commands](../../../../docs/cli.md).
