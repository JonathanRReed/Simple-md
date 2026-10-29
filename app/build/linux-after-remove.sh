#!/bin/sh
set -eu
if [ "$(readlink /usr/bin/simplemd 2>/dev/null || true)" = '/opt/SimpleMD/resources/native/simplemd' ]; then
  rm /usr/bin/simplemd
fi
