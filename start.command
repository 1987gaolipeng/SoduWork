#!/bin/sh
# macOS Finder entry; chmod +x start.command once if an archive lost permissions.
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)" || exit 1
sh ./start.sh "$@"
result=$?
if [ "$result" -ne 0 ] && [ -t 0 ]; then
  printf '%s\n' 'Startup failed. Press Return to close.'
  read -r unused
fi
exit "$result"
