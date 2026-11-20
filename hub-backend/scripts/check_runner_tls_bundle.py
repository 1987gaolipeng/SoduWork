"""Verify native system trust support in the actual PyInstaller Runner artifact."""
import sys
from pathlib import Path

from PyInstaller.archive.readers import CArchiveReader


def check(binary, *, platform=sys.platform):
    archive = CArchiveReader(str(binary))
    modules = archive.open_embedded_archive("PYZ.pyz").toc
    backend = {"darwin": "truststore._macos", "win32": "truststore._windows"}.get(
        platform, "truststore._openssl")
    required = {"truststore", "truststore._api", backend,
                "app.services.runner_tls", "app.services.runtime_tls"}
    if not required.issubset(modules):
        raise AssertionError("Frozen Runner is missing its native system trust verifier")
    print(f"PASS frozen Runner native system trust verifier ({platform})")


if __name__ == "__main__":
    check(Path(sys.argv[1]))
