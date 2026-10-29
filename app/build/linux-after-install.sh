#!/bin/sh
set -eu
# The Electron executable is simplemd-app, leaving simplemd for the CLI.
if [ "$(readlink /usr/bin/simplemd 2>/dev/null || true)" != '/opt/SimpleMD/resources/native/simplemd' ]; then
  ln -s '/opt/SimpleMD/resources/native/simplemd' '/usr/bin/simplemd'
fi
