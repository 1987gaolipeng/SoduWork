"""Runner-local enablement for the bundled Harness² core.

Uninstalling this runtime never removes its bundled code or the OpenCode
installation shared with the standalone OpenCode runtime.
"""
from __future__ import annotations

import os
from pathlib import Path
import tempfile


def _marker() -> Path:
    from .local_base import _data_root

    return Path(_data_root()) / "agents" / "harness2" / "disabled.json"


def disabled_issue() -> str:
    if _marker().exists():
        return "Google Harness² 已卸载；点「装上」重新启用。共享 OpenCode 执行组件已保留。"
    return ""


def disable() -> None:
    marker = _marker()
    marker.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=marker.parent, prefix=".disabled-", delete=False,
        ) as stream:
            temporary = Path(stream.name)
            stream.write('{"schemaVersion":1,"disabled":true}\n')
        os.replace(temporary, marker)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def enable() -> None:
    _marker().unlink(missing_ok=True)
