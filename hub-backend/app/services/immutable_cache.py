"""Cross-platform publication of immutable, content-addressed directory caches."""
from __future__ import annotations

import os
import shutil
import time


def publish_immutable_tree(tmp: str, target: str, ready: str) -> None:
    """Atomically publish *tmp* without overwriting another complete producer.

    Windows file scanners can briefly hold newly written files and make a directory rename fail
    with ``PermissionError``. Concurrent Hub/Runner processes can also win the same cache key.
    Both are expected races: retry transient locks, accept a target only when its ready marker is
    present, and never replace an existing immutable tree.
    """
    last_error: OSError | None = None
    for attempt in range(5):
        if os.path.isfile(ready):
            shutil.rmtree(tmp, ignore_errors=True)
            return
        try:
            os.rename(tmp, target)
            return
        except OSError as error:
            if os.path.isfile(ready):
                shutil.rmtree(tmp, ignore_errors=True)
                return
            retryable = isinstance(error, (FileExistsError, PermissionError)) or os.path.exists(target)
            if not retryable:
                raise
            last_error = error
            if attempt < 4:
                time.sleep(0.04 * (attempt + 1))
    if last_error is not None:
        raise last_error
    raise OSError("不可变目录缓存发布失败")
