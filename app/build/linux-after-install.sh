#!/bin/sh
set -eu
# The Electron executable is simplemd-app, leaving simplemd for the CLI.
ln -sfn '/opt/SimpleMD/resources/native/simplemd' '/usr/bin/simplemd'
