"""Publish renderer files from src_dir into a versioned release directory, hash each file, update
version.json, and insert the release record. Exclude Electron main/preload code and
dependencies. Usage: python publish_release.py <version> <src_dir> [notes].
"""
import asyncio
import hashlib
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(__file__))
from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402

RENDERER_INCLUDE = ["index.html", "api.js", "app", "components", "core", "theme"]
RELEASES = os.path.join(os.path.dirname(__file__), "releases")


def _add(srcfp, dstfp, rel, files):
    os.makedirs(os.path.dirname(dstfp), exist_ok=True)
    with open(srcfp, "rb") as f:
        buf = f.read()
    with open(dstfp, "wb") as f:
        f.write(buf)
    files.append({"path": rel, "sha256": hashlib.sha256(buf).hexdigest()})


def collect(src, dst):
    files = []
    for item in RENDERER_INCLUDE:
        s = os.path.join(src, item)
        if os.path.isfile(s):
            _add(s, os.path.join(dst, item), item, files)
        elif os.path.isdir(s):
            for root, _dirs, fnames in os.walk(s):
                for fn in fnames:
                    fp = os.path.join(root, fn)
                    rel = os.path.relpath(fp, src).replace("\\", "/")
                    _add(fp, os.path.join(dst, rel), rel, files)
    return files


async def main():
    if len(sys.argv) < 3:
        print("用法: python publish_release.py <version> <src_dir> [notes]")
        sys.exit(1)
    version, src = sys.argv[1], sys.argv[2]
    notes = sys.argv[3] if len(sys.argv) > 3 else ""
    dst = os.path.join(RELEASES, version)
    shutil.rmtree(dst, ignore_errors=True)
    os.makedirs(dst, exist_ok=True)

    files = collect(src, dst)
    # Write the release version into version.json for client version detection.
    vjson = json.dumps({"version": version})
    with open(os.path.join(dst, "version.json"), "w", encoding="utf-8") as f:
        f.write(vjson)
    files = [x for x in files if x["path"] != "version.json"]
    files.append({"path": "version.json", "sha256": hashlib.sha256(vjson.encode("utf-8")).hexdigest()})

    await init_db()
    async with SessionLocal() as s:
        r = await s.get(models.Release, version)
        if r is None:
            s.add(models.Release(version=version, channel="stable", notes=notes, files=files))
        else:
            r.notes = notes
            r.files = files
        await s.commit()
    print(f"published {version}: {len(files)} files -> {dst}")


asyncio.run(main())
