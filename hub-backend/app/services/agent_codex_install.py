"""Repair the resolved Codex optional dependency without destroying an old copy."""
from __future__ import annotations

from pathlib import Path
import shutil
import uuid

from . import agent_setup_runtime as runtime


def _linked(path: Path) -> bool:
    return path.is_symlink() or bool(getattr(path.lstat(), "st_file_attributes", 0) & 0x400)


def repair_native(run) -> tuple[int, str]:
    version = runtime._codex_dependency_version()
    spec = runtime._codex_native_spec(version)
    directory = runtime._codex_package_dir()
    if not (spec and directory):
        return 2, "Codex Harness 主包已安装，但无法识别当前平台或 Codex 依赖版本。"
    root = Path(directory).resolve()
    target = root.joinpath("node_modules", *runtime._codex_native_name().split("/"))
    # Refuse links before recursive copies/deletes; never follow a dependency
    # junction into another installation, including one inside this package.
    if not target.resolve().is_relative_to(root):
        return 2, "Codex 原生依赖路径超出安装目录，请检查安装环境。"
    try:
        for cursor in (target, *target.parents):
            if cursor == root:
                break
            if cursor.exists() and _linked(cursor):
                return 2, "Codex 原生依赖含目录链接，请检查安装环境后重试。"
        if target.exists() and any(_linked(item) for item in target.rglob("*")):
            return 2, "Codex 原生依赖含文件链接，请检查安装环境后重试。"
    except OSError:
        return 2, "Codex 原生依赖目录无法读取，请检查安装权限后重试。"
    backup = root / (".sw-native-" + uuid.uuid4().hex[:12])
    copied = False
    ready = False
    code = 2
    detail = "Codex 原生执行包未能完整安装，请检查安装日志后重试。"
    try:
        if target.exists():
            # Some Windows encryption filters reject directory renames even
            # with no running CLI. Copy first; a failed copy leaves source intact.
            shutil.copytree(target, backup, symlinks=True)
            copied = True
            assert target.resolve().is_relative_to(root)
            shutil.rmtree(target)
        # npm does not repair deleted payload files in an already installed
        # same-version package. Removing only this backed-up dependency forces extraction.
        code, _output = run([
            "install", "--prefix=" + str(root), "--no-save", "--package-lock=false",
            "--include=optional", "--engine-strict", spec,
        ], timeout=900)
        ready = code == 0 and runtime._codex_native_matches(
            version, runtime._codex_native_version())
    except OSError as error:
        code = 2
        number = getattr(error, "winerror", None) or error.errno
        detail = f"Codex 原生依赖无法替换（系统错误 {number}），请关闭正在使用它的会话并检查目录权限后重试。"
    except Exception:
        code = 2
        detail = "Codex 原生依赖安装中断，请检查安装环境后重试。"
    if copied and not ready:
        try:
            if target.exists():
                if not target.resolve().is_relative_to(root) or _linked(target):
                    return 2, "Codex 安装路径发生变化，原依赖备份已保留。"
                try:
                    shutil.rmtree(target)
                except OSError:
                    return 2, "Codex 安装未完成，无法清理新依赖目录；原依赖备份已保留，请检查目录权限后重试。"
            # Never merge into a tree npm left behind: it can contain new
            # reparse points that were absent during the initial validation.
            shutil.copytree(backup, target, symlinks=True)
        except OSError:
            return 2, "Codex 安装未完成，原依赖备份已保留，请检查目录权限后重试。"
    if backup.exists():
        try:
            assert backup.resolve().parent == root
            shutil.rmtree(backup)
        except OSError:
            if ready:
                return 0, "Codex 执行包已修复；旧依赖备份暂时保留。"
    return (0, "") if ready else (code or 2, detail)
