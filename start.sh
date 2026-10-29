#!/bin/sh
# Run with: sh start.sh [--data-dir /private/path] [--port 18989]
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
for python_bin in python3 python3.14 python3.13 python3.12 python; do
  if command -v "$python_bin" >/dev/null 2>&1 &&
     "$python_bin" -c 'import sys; sys.exit(sys.version_info < (3, 12))' >/dev/null 2>&1; then
    exec "$python_bin" start.py "$@"
  fi
done
printf '%s\n' 'Install Python 3.12+ and Node.js 22+ first. See docs/getting-started.md.' >&2
exit 1
