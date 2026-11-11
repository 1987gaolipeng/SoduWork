"""Release gate for terminal host-policy and secret-boundary regressions."""
from pathlib import Path
import unittest


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.discover(
        str(Path(__file__).resolve().parent.parent / "tests"), pattern="test_terminal_security.py")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
