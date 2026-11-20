"""Windows source-copy path diagnostics without changing system settings."""
from __future__ import annotations

import errno
from pathlib import Path
import sys
import tempfile
from typing import Iterable


class WindowsPathError(OSError):
    """The current process could write a short path but not a required long path."""


def windows_path_units(path: Path | str) -> int:
    return len(str(path).encode("utf-16-le", errors="surrogatepass")) // 2


def windows_long_paths_enabled() -> bool | None:
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                            r"SYSTEM\CurrentControlSet\Control\FileSystem") as key:
            value, _ = winreg.QueryValueEx(key, "LongPathsEnabled")
        return value == 1
    except (ImportError, OSError):
        return None


def check_windows_source_paths(state: Path, relative_paths: Iterable[Path], *, probe: bool) -> None:
    """Check only copied source paths; downloaded dependency trees are not predicted."""
    if sys.platform != "win32":
        return
    # Store Python can redirect LocalAppData. Resolve again after initialization
    # has created the directory, so the physical path contributes to its length.
    state = state.resolve()
    target = max((state / path for path in relative_paths), key=windows_path_units, default=None)
    if target is None:
        return
    length = windows_path_units(target)
    if not probe:
        enabled = windows_long_paths_enabled()
        setting = "unknown / 未知" if enabled is None else str(int(enabled))
        print(f"Win32 LongPathsEnabled: {setting}\n"
              f"源文件最长目标路径 / Longest source-file target "
              f"({length} UTF-16 code units / 代码单元): {target}")
        if length >= 260:
            print("路径可能受 Windows 长路径限制；只读检查未测试写入。\n"
                  "Paths may be affected by Windows long-path limits; this read-only check did not test writes.")
        return
    if length < 260:
        return
    # A registry value alone cannot establish the running process's capability
    # (it may be cached, or the caller may use an extended-length path prefix).
    with tempfile.TemporaryDirectory(prefix=".path-", dir=state) as temporary:
        directory = Path(temporary)
        control = directory / "c"
        control.write_bytes(b"ok")
        remaining = length - windows_path_units(directory) - 1
        try:
            # Match the actual target length, including the random scratch name;
            # keep each component below the filesystem's component limit.
            while remaining > 120:
                directory /= "p" * min(100, remaining - 2)
                directory.mkdir()
                remaining = length - windows_path_units(directory) - 1
            candidate = directory / ("p" * remaining)
            candidate.write_bytes(b"ok")
            candidate.read_bytes()
        except OSError as exc:
            if (exc.errno in {errno.ENOENT, errno.ENAMETOOLONG}
                    or getattr(exc, "winerror", None) in {3, 206}) and control.is_file():
                raise WindowsPathError(
                    "当前 Windows 进程无法访问源码所需的长路径。\n"
                    "This Windows process cannot access the long paths required by the source copy.\n"
                    f"目标 / Target ({length} UTF-16 code units / 代码单元): {target}\n"
                    "请启用 Win32 长路径支持后重新打开终端，再运行同一启动命令。\n"
                    "Enable Win32 long paths, reopen the terminal, and rerun the same command.\n"
                    "仅新建独立实例可选择更短的 --data-dir；原有数据请保留原位，不要删除或迁移。\n"
                    "Only a new, separate instance may use a shorter --data-dir; keep existing data in place."
                ) from exc
            raise
