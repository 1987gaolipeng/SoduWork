"""Prepare and run a private, single-host SoduWork deployment."""
import sys
if sys.version_info < (3, 12):
    raise SystemExit("Python 3.12+ is required. See ops/self-host/README.md.")
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.dev.deploy import main
if __name__ == "__main__":
    raise SystemExit(main())
