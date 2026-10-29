# -*- coding: utf-8 -*-
"""Package plugin JSON definitions as .soduwork-plugin ZIP archives and validate them with
plugin_packages.parse immediately. Accept an explicit file or package the full plugins
directory; place rebuildable outputs under dist/plugins.
"""
from __future__ import annotations

import io
import json
import os
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.services import plugin_packages  # noqa: E402

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plugins")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist", "plugins")


def pack(path: str) -> str:
    with open(path, encoding="utf-8") as f:
        manifest = json.load(f)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("plugin.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    data = buf.getvalue()
    parsed = plugin_packages.parse(data)          # Use the production parser so invalid plugins fail during packaging.
    os.makedirs(OUT, exist_ok=True)
    name = "%s-%s.soduwork-plugin" % (parsed["manifest"]["key"], parsed["manifest"]["version"])
    target = os.path.join(OUT, name)
    with open(target, "wb") as f:
        f.write(data)
    nodes = parsed["workflow"]["nodes"]
    print("  OK  %-28s %2d 个节点：%s" % (
        name, len(nodes), " → ".join(x["key"] for x in nodes)))
    return target


def main(argv: list[str]) -> int:
    files = argv[1:] or sorted(
        os.path.join(SRC, x) for x in os.listdir(SRC) if x.endswith(".json"))
    bad = 0
    for path in files:
        try:
            pack(path)
        except Exception as e:  # noqa: BLE001
            bad += 1
            print("  FAIL  %s：%s" % (os.path.basename(path), e))
    print("\n%d 个插件，%d 个没打成" % (len(files), bad))
    return bad


if __name__ == "__main__":
    sys.exit(1 if main(sys.argv) else 0)
