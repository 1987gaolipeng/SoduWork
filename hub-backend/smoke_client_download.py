"""Public installer selection must follow semantic versions, never mtimes."""
from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./.smoke-client-download.db"

from app.api import download


def touch(path: Path, mtime: int) -> None:
    path.write_bytes(b"installer")
    os.utime(path, (mtime, mtime))


def main() -> None:
    original = download._DIR
    with tempfile.TemporaryDirectory(prefix="soduwork-download-selection-") as raw:
        root = Path(raw)
        download._DIR = root
        try:
            touch(root / "SoduWork-1.10.0-Setup.exe", 100)
            touch(root / "SoduWork-1.9.99-Setup.exe", 300)
            touch(root / "SoduWork-invalid-Setup.exe", 500)
            touch(root / "SoduWork-Setup.exe", 600)
            touch(root / "soduwork.exe", 700)
            assert download._pkg().name == "SoduWork-1.10.0-Setup.exe"
            assert download._package_version(download._pkg()) == "1.10.0"
            from app.db import Base, engine, get_session as open_session

            async def _dir_info(endpoint=download.client_info):
                # This test isolates the downloads-directory fallback, so the release-channel table stays empty.
                async with engine.begin() as conn:
                    await conn.run_sync(Base.metadata.create_all)
                agen = open_session()
                session = await agen.__anext__()
                try:
                    return await endpoint(session)
                finally:
                    await agen.aclose()

            info = asyncio.run(_dir_info())
            assert info["version"] == "1.10.0"
            assert info["artifactFilename"] == "SoduWork-1.10.0-Setup.exe"

            touch(root / "SoduWork-Mobile-1.12.12.apk", 100)
            touch(root / "SoduWork-Mobile-1.9.99.apk", 900)
            touch(root / "SoduWork-Mobile-invalid.apk", 1000)
            assert download._mobile_pkg().name == "SoduWork-Mobile-1.12.12.apk"
            assert download._mobile_package_version(download._mobile_pkg()) == "1.12.12"
            mobile = asyncio.run(_dir_info(download.mobile_info))
            assert mobile["available"] is True
            assert mobile["version"] == "1.12.12"
            assert mobile["artifactFilename"] == "SoduWork-Mobile-1.12.12.apk"
            assert mobile["filename"] == "SoduWork-Mobile.apk"
            assert mobile["webUrl"] == "/mobile/"

            (root / "SoduWork-1.10.0-Setup.exe").unlink()
            (root / "SoduWork-1.9.99-Setup.exe").unlink()
            assert download._pkg().name == "SoduWork-Setup.exe"
            assert download._package_version(download._pkg()) == ""

            (root / "SoduWork-Setup.exe").unlink()
            assert download._pkg().name == "soduwork.exe"
        finally:
            download._DIR = original
    print("client and mobile download selection: 14 assertions green")


if __name__ == "__main__":
    main()
