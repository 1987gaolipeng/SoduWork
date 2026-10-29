"""Read-only Skill package inspection; never interpret or execute embedded content."""
from __future__ import annotations

import base64
import hashlib
import io
import os
from pathlib import Path
import zipfile

TEXT_CHUNK = 64 * 1024
MAX_BYTES = 30 * 1024 * 1024
MAX_FILES = 300
_TEXT = {".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".csv", ".tsv", ".xml",
         ".html", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py",
         ".sh", ".bash", ".ps1", ".bat", ".ini", ".cfg", ".sql", ".svg"}
_IMAGE = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
          ".gif": "image/gif", ".webp": "image/webp"}


def safe_path(value: str) -> str:
    name = str(value or "").replace("\\", "/")
    parts = name.split("/")
    reserved = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)),
                *(f"lpt{i}" for i in range(1, 10))}
    if not name or any(not p or p in {".", ".."} or p.endswith((".", " ")) or
                       any(c in '<>:"|?*' or ord(c) < 32 for c in p) or
                       p.split(".", 1)[0].lower() in reserved for p in parts):
        raise ValueError("Skill 文件路径不安全")
    if name.casefold() == ".ready":
        raise ValueError("Skill 包不能包含内部缓存标记")
    return name


def read_files(directory: str) -> dict[str, bytes]:
    root = Path(directory).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Skill 目录不存在")
    files, total = {}, 0
    for current, dirs, names in os.walk(root, followlinks=False):
        if any(Path(current, name).is_symlink() for name in dirs):
            raise ValueError("Skill 包不能包含符号链接")
        for name in sorted(names):
            file = Path(current, name)
            relative = file.relative_to(root).as_posix()
            if relative == ".ready":
                continue
            safe_path(relative)
            target = file.resolve(strict=True)
            if file.is_symlink() or not target.is_relative_to(root) or not target.is_file():
                raise ValueError("Skill 包包含不安全文件")
            size = target.stat().st_size
            total += size
            if len(files) >= MAX_FILES or total > MAX_BYTES:
                raise ValueError("Skill 包文件超过 300 个或内容超过 30MB")
            data = target.read_bytes()
            if len(data) != size:
                raise ValueError("Skill 文件正在变化，请刷新后重试")
            files[relative] = data
    if "SKILL.md" not in files:
        raise ValueError("Skill 包缺少 SKILL.md")
    return files


def kind(name: str, data: bytes) -> str:
    suffix = Path(name).suffix.lower()
    if suffix in _IMAGE:
        return "image"
    if suffix in _TEXT or not suffix:
        try:
            data.decode("utf-8-sig")
            if b"\0" not in data:
                return "text"
        except UnicodeDecodeError:
            pass
    return "binary"


def listing(files: dict[str, bytes]) -> list[dict]:
    return [{"path": name, "bytes": len(data), "kind": kind(name, data),
             "sha256": hashlib.sha256(data).hexdigest()}
            for name, data in sorted(files.items(), key=lambda x: (x[0] != "SKILL.md", x[0]))]


def view(files: dict[str, bytes], name: str, offset: int = 0) -> dict:
    relative = safe_path(name)
    if relative not in files:
        raise FileNotFoundError("Skill 包中没有这个文件")
    data = files[relative]
    format = kind(relative, data)
    result = {"path": relative, "kind": format, "bytes": len(data),
              "sha256": hashlib.sha256(data).hexdigest()}
    if format == "text":
        # Character offsets keep a Chinese/emoji boundary intact across pages.
        text = data.decode("utf-8-sig")
        start = max(0, min(int(offset), len(text)))
        end = min(start + TEXT_CHUNK, len(text))
        result.update(text=text[start:end], offset=start, totalCharacters=len(text),
                      nextOffset=end if end < len(text) else None)
    elif format == "image":
        result.update(mediaType=_IMAGE[Path(relative).suffix.lower()],
                      base64=base64.b64encode(data).decode("ascii"))
    else:
        result["message"] = "此文件不支持文本预览，可下载原文件查看。"
    return result


def archive(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as output:
        for name, data in sorted(files.items()):
            entry = zipfile.ZipInfo(safe_path(name), date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            output.writestr(entry, data)
    return buffer.getvalue()
