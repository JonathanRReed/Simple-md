#!/bin/sh
# @raycast.schemaVersion 1
# @raycast.title Open in SimpleMD
# @raycast.mode silent
# @raycast.packageName SimpleMD
# @raycast.argument1 {"type":"text","placeholder":"File path, :line or #heading"}
set -eu
exec simplemd -- "$1"
