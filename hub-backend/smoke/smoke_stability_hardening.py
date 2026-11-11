"""Release-gate entry for stability hardening regressions kept under tests/."""
from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest


MODULES = (
    "tests.test_runner_heartbeat_persistence",
    "tests.test_stability_hardening",
)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="soduwork-stability-hardening-") as directory:
        root = Path(directory)
        # These regressions mock persistence. Give imports an isolated database
        # and data root anyway so a direct smoke run cannot touch developer state.
        os.environ["DATABASE_URL"] = (
            "sqlite+aiosqlite:///" + (root / ".smoke.db").as_posix())
        os.environ["SODUWORK_DATA_ROOT"] = str(root / "data")
        suite = unittest.defaultTestLoader.loadTestsFromNames(MODULES)
        result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
