"""Start an isolated local SoduWork service and its management UI."""
import sys

if sys.version_info < (3, 12):
    print("SoduWork needs Python 3.12 or newer: https://www.python.org/downloads/", file=sys.stderr)
    raise SystemExit(1)

from tools.dev.start_local import main


if __name__ == "__main__":
    raise SystemExit(main())
