"""Offline process acceptance: client exit, real WebSocket loss and cold recovery."""
from pathlib import Path
import tempfile

from e2e_cloud_durable_execution import run


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="cloud-durable-gate-") as directory:
        run(Path(directory))
