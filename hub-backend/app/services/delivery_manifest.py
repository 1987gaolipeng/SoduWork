"""Shared pure functions classifying deliverables as primary, supporting, evidence, or internal.
Runners, ingestion, workflow contracts, task views, and completion gates use the same rules.
"""
from __future__ import annotations

import io
import codecs
import json
import os
import re
import zipfile


SCHEMA_VERSION = "1.0"
_CATEGORIES = ("primary", "supporting", "evidence", "internal")
_INTERNAL_DIRS = {
    ".git", ".idea", ".vscode", ".cache", ".pytest_cache", "__pycache__",
    "node_modules", "coverage", ".next", ".nuxt",
}
_INTERNAL_EXTS = {
    ".so", ".dll", ".dylib", ".o", ".obj", ".pyc", ".pyo", ".pdb",
    ".class", ".log", ".tmp", ".temp", ".swp", ".lock",
}
_PRIMARY_EXTS = {
    ".zip", ".7z", ".rar", ".tar", ".gz", ".pdf", ".doc", ".docx",
    ".xls", ".xlsx", ".ppt", ".pptx", ".md", ".txt", ".html", ".htm",
    ".csv", ".json", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg",
    ".mp3", ".wav", ".mp4", ".mov",
}
_SUPPORT_EXTS = {
    ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue",
    ".py", ".java", ".go", ".rs", ".c", ".cc", ".cpp", ".h", ".hpp",
    ".xml", ".yaml", ".yml", ".toml", ".ini", ".sql", ".sh", ".ps1",
    ".woff", ".woff2", ".ttf", ".ico", ".map",
}
_EVIDENCE_WORDS = re.compile(
    r"(^|[/_.-])(screen(?:shot)?|preview|evidence|proof|qa|test[-_ ]?report|"
    r"截图|预览|证据|验收|测试报告)([/_.-]|$)", re.I)
_BUNDLE_WORDS = re.compile(r"(^|[/_.-])(完整产出|交付包|deliverable|artifact|bundle)([/_.-]|$)", re.I)
_ZIP_MAX_ENTRIES = 10_000
_ZIP_MAX_FILE = 512 * 1024 * 1024
_ZIP_MAX_UNPACKED = 2 * 1024 * 1024 * 1024
_ZIP_RATIO_GRACE = 64 * 1024 * 1024
_ZIP_MAX_RATIO = 1_000


def normalize_name(value: object) -> str:
    """Normalize a relative path and remove traversal components."""
    text = str(value or "").replace("\\", "/").lstrip("/")
    parts = [part for part in text.split("/") if part not in ("", ".", "..")]
    return "/".join(parts)[:300]


def classify_name(name: object, *, role: str = "output", meta: dict | None = None) -> str:
    """Return primary, supporting, evidence, or internal, giving explicit roles precedence."""
    path = normalize_name(name)
    role = str(role or "").lower()
    meta = dict(meta or {})
    kind = str(meta.get("kind") or meta.get("type") or "").lower()
    if role == "verification" or kind in {
            "screenshot", "preview", "proof", "evidence", "test", "qa", "code_review"}:
        return "evidence"
    explicit = str(meta.get("category") or "").strip().lower()
    if explicit in _CATEGORIES:
        return explicit
    if role in {"input", "process"}:
        return "internal"
    if not path:
        return "internal"
    parts = [part.lower() for part in path.split("/")]
    base = parts[-1]
    ext = os.path.splitext(base)[1]
    if any(part in _INTERNAL_DIRS or part.startswith(".tmp") for part in parts[:-1]):
        return "internal"
    if base.startswith(".") or base in {"thumbs.db", "desktop.ini", "package-lock.json"}:
        return "internal"
    if ext in _INTERNAL_EXTS or base.endswith(("~", ".bak")):
        return "internal"
    if _EVIDENCE_WORDS.search(path):
        return "evidence"
    if _BUNDLE_WORDS.search(path) or base in {"index.html", "index.htm", "readme.md"}:
        return "primary"
    if ext in _PRIMARY_EXTS:
        # Nested images and pages usually support a complete deliverable; root-level files may stand alone.
        return "supporting" if "/" in path else "primary"
    if ext in _SUPPORT_EXTS:
        return "supporting"
    return "internal"


def is_deliverable_name(name: object, *, explicit: bool = False) -> bool:
    """Generic evidence accepts reviewable deliverables; explicit file contracts can accept any
    non-temporary file.
    """
    path = normalize_name(name)
    if not path:
        return False
    category = classify_name(path)
    if category != "internal":
        return True
    if not explicit:
        return False
    parts = [part.lower() for part in path.split("/")]
    base = parts[-1]
    return not (any(part in _INTERNAL_DIRS for part in parts[:-1])
                or base.startswith(".") or base.endswith(("~", ".tmp", ".temp", ".log")))


def _failed(reason: str, **detail) -> dict:
    return {"state": "failed", "reason": reason, **detail}


async def code_truncation(name: str, data: bytes) -> str | None:
    """Detect structurally unfinished code at end of file without rejecting unfamiliar complete
    syntax. Skip JavaScript checks if Node is unavailable; use standard-library AST checks for
    Python.
    """
    import ast
    import asyncio
    import shutil

    ext = str(name or "").lower().rpartition(".")[2]
    if ext in ("js", "mjs", "cjs"):
        node = shutil.which("node")
        if not node:
            return None
        # Check JavaScript syntax in module mode without executing code.
        # Runtime identifiers such as require and module.exports are not resolved by --check.
        try:
            proc = await asyncio.create_subprocess_exec(
                node, "--check", "--input-type=module", "-",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        except OSError:
            return None
        try:
            _, err = await asyncio.wait_for(proc.communicate(data), timeout=15)
        except (asyncio.TimeoutError, TimeoutError):
            proc.kill()
            return None
        if proc.returncode == 0:
            return None
        text = (err or b"").decode("utf-8", "replace")
        if re.search(r"unexpected end of input|unexpected end of file", text, re.I):
            return "代码在结尾处被截断（括号/结构未闭合）"
        return None
    if ext == "py":
        try:
            ast.parse(data.decode("utf-8", "replace"))
            return None
        except SyntaxError as exc:
            message = str(exc).lower()
            if ("eof" in message or "unexpected end" in message
                    or "never closed" in message):
                return "Python 代码在结尾处被截断（结构未闭合）"
            return None
    return None


def _zip_validation(name: str, data: bytes) -> dict:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            if len(infos) > _ZIP_MAX_ENTRIES:
                return _failed("压缩包文件数量过多", entries=len(infos))
            raw_names = [item.filename.replace("\\", "/") for item in infos]
            unsafe = any(
                not raw or "\x00" in raw or raw.startswith("/")
                or re.match(r"^[A-Za-z]:($|/)", raw) is not None
                or any(part == ".." for part in raw.split("/"))
                for raw in raw_names)
            if unsafe:
                return _failed("压缩包包含不安全路径")
            file_names = [normalize_name(item.filename) for item in infos if not item.is_dir()]
            if len(file_names) != len(set(file_names)):
                return _failed("压缩包包含归一化后重名的文件")
            names = [normalize_name(x) for x in raw_names if normalize_name(x)]
            if not names:
                return _failed("压缩包里没有文件")
            unpacked = sum(max(0, int(item.file_size or 0)) for item in infos)
            if any(int(item.file_size or 0) > _ZIP_MAX_FILE for item in infos):
                return _failed("压缩包包含过大的单个文件")
            if unpacked > _ZIP_MAX_UNPACKED:
                return _failed("压缩包解压后体积过大", bytes=unpacked)
            if unpacked > max(_ZIP_RATIO_GRACE, len(data) * _ZIP_MAX_RATIO):
                return _failed("压缩包解压倍率异常", bytes=unpacked)
            ext = os.path.splitext(name.lower())[1]
            required = {
                ".docx": "word/", ".xlsx": "xl/", ".pptx": "ppt/",
            }.get(ext)
            if required and ("[Content_Types].xml" not in names
                             or not any(x.startswith(required) for x in names)):
                return _failed(f"不是有效的 {ext.lstrip('.')} 文件")
            return {"state": "passed", "entries": len(names)}
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError) as exc:
        return _failed("压缩结构损坏", error=type(exc).__name__)


def validate_bytes(name: object, data: bytes | bytearray | None,
                   content_type: str = "") -> dict:
    """Perform lightweight structural validation on bytes without executing files or extracting
    them to disk.
    """
    path = normalize_name(name)
    raw = bytes(data or b"")
    if not raw:
        return _failed("文件为空")
    ext = os.path.splitext(path.lower())[1]
    if ext in {".zip", ".docx", ".xlsx", ".pptx"}:
        return _zip_validation(path, raw)
    if ext == ".pdf" and not raw.startswith(b"%PDF-"):
        return _failed("不是有效的 PDF 文件")
    if ext == ".png":
        png_end = b"\x00\x00\x00\x00IEND\xaeB\x60\x82"
        if (len(raw) < 45 or not raw.startswith(b"\x89PNG\r\n\x1a\n") or
                raw[8:12] != b"\x00\x00\x00\x0d" or raw[12:16] != b"IHDR" or
                int.from_bytes(raw[16:20], "big") < 1 or
                int.from_bytes(raw[20:24], "big") < 1 or not raw.endswith(png_end)):
            return _failed("PNG 图片结构不完整")
    if ext in {".jpg", ".jpeg"} and (len(raw) < 12 or
            not raw.startswith(b"\xff\xd8\xff") or not raw.endswith(b"\xff\xd9")):
        return _failed("JPEG 图片结构不完整")
    if ext == ".gif" and (len(raw) < 14 or
            not raw.startswith((b"GIF87a", b"GIF89a")) or raw[-1:] != b"\x3b"):
        return _failed("GIF 图片结构不完整")
    if ext == ".webp":
        declared = int.from_bytes(raw[4:8], "little") + 8 if len(raw) >= 12 else 0
        if (len(raw) < 20 or not raw.startswith(b"RIFF") or raw[8:12] != b"WEBP" or
                declared < 20 or declared > len(raw)):
            return _failed("WebP 图片结构不完整")
    if ext == ".json":
        try:
            json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            return _failed("JSON 内容无法解析", error=type(exc).__name__)
    if ext in {".html", ".htm"}:
        # Windows shell writers can produce BOM-marked UTF-16 pages. Inspect
        # their decoded markup while preserving the original delivery bytes.
        encoding = "utf-16" if raw.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)) else "utf-8"
        decoder = codecs.getincrementaldecoder(encoding)(errors="strict" if encoding == "utf-16" else "ignore")
        try:
            text = decoder.decode(raw[:65536], final=len(raw) <= 65536).lower()
        except UnicodeError:
            return _failed("HTML 文本编码无法解析")
        if not any(tag in text for tag in ("<!doctype html", "<html", "<body", "<main")):
            return _failed("HTML 缺少可识别的页面结构")
    if ext == ".svg":
        text = raw[:8192].decode("utf-8", errors="ignore").lower()
        if "<svg" not in text:
            return _failed("不是有效的 SVG 图片")
    return {"state": "passed"}


def _validation(meta: dict) -> dict:
    value = meta.get("verification") or meta.get("validation") or {}
    if not isinstance(value, dict):
        return {"state": "unverified", "reason": "尚未校验文件结构"}
    state = str(value.get("state") or "unverified")
    return {"state": state, **{k: v for k, v in value.items() if k != "state"}}


def item_from_attachment(row) -> dict:
    meta = dict(getattr(row, "evidence_meta", None) or {})
    name = normalize_name(getattr(row, "filename", ""))
    role = str(getattr(row, "role", "") or "input")
    category = classify_name(name, role=role, meta=meta)
    try:
        round_no = max(0, int(meta.get("round") or 0))
    except (TypeError, ValueError):
        round_no = 0
    return {
        "id": str(getattr(row, "id", "") or ""), "name": name,
        "size": int(getattr(row, "size", 0) or 0),
        "sha256": str(meta.get("sha256") or ""),
        "contentType": str(getattr(row, "content_type", "") or "application/octet-stream"),
        "role": role, "category": category,
        "sourceRef": str(getattr(row, "source_ref", "") or ""),
        **({"round": round_no} if round_no else {}),
        "url": "/attachments/" + str(getattr(row, "id", "") or ""),
        "validation": _validation(meta),
    }


def unique_output_source(manifest: dict) -> str:
    """Recover provenance only when every frozen output identifies one verified producer."""
    if not isinstance(manifest, dict) or manifest.get("complete") is not True:
        return ""
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        return ""
    refs = set()
    for item in files:
        if not isinstance(item, dict) or item.get("role") != "output":
            return ""
        validation = item.get("validation")
        ref = item.get("sourceRef")
        digest = item.get("sha256")
        if (not isinstance(validation, dict) or validation.get("state") != "passed"
                or not isinstance(ref, str) or not ref.strip() or len(ref) > 160
                or not isinstance(digest, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", digest)):
            return ""
        refs.add(ref.strip())
    return next(iter(refs)) if len(refs) == 1 else ""


def build(rows: list, *, source_ref: str = "", url: str = "") -> dict:
    """Build a stable attachment snapshot, excluding input materials from delivery versions."""
    generation = 0
    if source_ref:
        for row in rows or []:
            if str(getattr(row, "source_ref", "") or "") != source_ref:
                continue
            try:
                generation = max(generation, int(
                    dict(getattr(row, "evidence_meta", None) or {}).get("round") or 0))
            except (TypeError, ValueError):
                pass
    picked = []
    for row in rows or []:
        role = str(getattr(row, "role", "") or "input")
        row_ref = str(getattr(row, "source_ref", "") or "")
        if source_ref and row_ref != source_ref:
            continue
        if generation:
            try:
                row_generation = int(
                    dict(getattr(row, "evidence_meta", None) or {}).get("round") or 0)
            except (TypeError, ValueError):
                row_generation = 0
            if row_generation != generation:
                continue
        if role == "input":
            continue
        # Exclude failed validation results from deliverable manifests, even for historical output-role records.
        # A corrupted file must not block review of other valid outputs from the turn.
        meta = dict(getattr(row, "evidence_meta", None) or {})
        if str(dict(meta.get("verification") or {}).get("state") or "") == "failed":
            continue
        picked.append(item_from_attachment(row))
    latest = {}
    for item in picked:
        latest[item["name"]] = item
    groups = {key: [] for key in _CATEGORIES}
    for item in latest.values():
        groups[item["category"]].append(item)
    for values in groups.values():
        values.sort(key=lambda x: x["name"])
    output_items = groups["primary"] + groups["supporting"]
    problems = []
    for item in output_items:
        state = str(item["validation"].get("state") or "unverified")
        if state != "passed":
            problems.append({
                "code": "invalid_output" if state == "failed" else "unverified_output",
                "name": item["name"],
                "detail": str(item["validation"].get("reason") or "成果未通过结构校验"),
            })
    clean_url = str(url or "").strip()
    complete = bool((groups["primary"] or clean_url) and not problems)
    return {
        "schemaVersion": SCHEMA_VERSION, "complete": complete, "url": clean_url,
        "files": output_items, **groups, "problems": problems,
        "counts": {key: len(groups[key]) for key in _CATEGORIES},
    }
