# Alfred script command

Install the SimpleMD CLI. In Alfred, connect a keyword with a required argument to a Run Script action. Select `/bin/sh` and input as argv, then use:

```sh
exec /absolute/path/to/simplemd -- "$1"
```

Use the path printed by SimpleMD's Install Command Line Tool action. Enter an absolute document path after the keyword. Append `:42` for a line or `#heading` for a GitHub heading slug. The included `open-simplemd.sh` contains the same command for environments whose PATH already includes the CLI.

This directory contains scripts and instructions, not an Alfred extension package. See [CLI commands](../../../../docs/cli.md).
