"""Complete-file handshake for the isolated Runner's synthetic native peer."""
from __future__ import annotations

import os
from pathlib import Path
import tempfile


def publish_pid(path: Path, pid: int) -> None:
    """Publish a closed file atomically; mere creation is not readiness."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        raise ValueError("Readiness requires a positive process ID")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="ascii", newline="\n",
                dir=path.parent, prefix=path.name + ".", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(f"{pid}\n")
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def read_pid(path: Path) -> int | None:
    """An absent, inaccessible, empty or incomplete marker is not ready yet."""
    try:
        value = path.read_text(encoding="ascii")
    except (OSError, UnicodeError):
        return None
    # The terminator also rejects an in-progress/legacy partial integer write.
    if not value.endswith("\n"):
        return None
    number = value[:-1]
    if not number.isascii() or not number.isdecimal() or len(number) > 20:
        return None
    pid = int(number)
    return pid if pid > 0 else None
