"""One bounded merge for task downloads and cross-device delivery snapshots.

Complete Runner archives cover one snapshot. Independent attachments can follow
them; keep every selected file, deduplicate identical bytes and reject conflicts.
Selection and authorization remain with the caller.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import mimetypes
import re
import zipfile

from fastapi import HTTPException

from . import delivery_collections as collections, delivery_manifest, storage


def task_download_limits():
    """Keep the existing task ZIP policy, independent of library upload limits."""
    return collections.ValidationLimits(
        max_bytes=delivery_manifest._ZIP_MAX_UNPACKED,
        max_files=delivery_manifest._ZIP_MAX_ENTRIES,
        max_unpacked=delivery_manifest._ZIP_MAX_UNPACKED,
        max_ratio=delivery_manifest._ZIP_MAX_RATIO,
        ratio_grace=delivery_manifest._ZIP_RATIO_GRACE,
        max_file_bytes=delivery_manifest._ZIP_MAX_FILE)


def _file(path, data, role="supporting", content_type=""):
    return {"path": collections.safe_path(path), "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(), "role": role,
            "contentType": content_type or mimetypes.guess_type(path)[0] or "application/octet-stream"}


def _online_dependencies(name, data):
    if not name.lower().endswith((".html", ".htm", ".css")):
        return []
    text = data[:2 * 1024 * 1024].decode("utf-8", errors="replace")
    patterns = [r'<(?:script|img|iframe|audio|video|source|link)\b[^>]*?\b(?:src|href)\s*=\s*[\x22\x27](https?://[^\x22\x27<>\s]+)',
                r'(?:url\(\s*[\x22\x27]?|@import\s+[\x22\x27])(https?://[^\x22\x27)<>\s]+)']
    return [url[:500] for pattern in patterns for url in re.findall(pattern, text, re.I)][:50]


def _describe_bundle(raw, limits):
    files, contents, dependencies, total = [], [], [], 0
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            infos = archive.infolist()
            if len(infos) > limits.max_files * 2:
                raise HTTPException(413, "成果包中的文件过多")
            for info in infos:
                if info.is_dir():
                    continue
                total += info.file_size
                if (len(files) >= limits.max_files or info.file_size > limits.file_bytes
                        or total > limits.max_unpacked
                        or total > max(limits.ratio_grace, len(raw) * limits.max_ratio)):
                    raise HTTPException(413, "成果包解压大小超过限制")
                data = archive.read(info)
                dependencies.extend(_online_dependencies(info.filename, data))
                category = delivery_manifest.classify_name(info.filename)
                files.append(_file(info.filename, data,
                    "primary" if category == "primary" else "supporting"))
                contents.append(data)
    except (zipfile.BadZipFile, RuntimeError, ValueError) as exc:
        raise HTTPException(422, "完整成果包结构无效") from exc
    # Validate the source before repacking so links and malformed/duplicate
    # members cannot be laundered into ordinary files in the merged archive.
    checked = collections.clean_manifest({"source": "cloud", "sessionId": "archive",
        "revision": "verify", "kind": "bundle", "files": files}, limits=limits)
    collections.validate_payload(checked, raw, limits=limits)
    return files, contents, dependencies


def _bundle(files, contents):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for item, data in zip(files, contents):
            archive.writestr(item["path"], data)
    return output.getvalue()


def _merge_file(merged, item, data, limits):
    key = item["path"].casefold()
    previous = merged.get(key)
    if previous:
        prior = previous[0]
        if (prior["path"] != item["path"] or prior["sha256"] != item["sha256"]
                or prior["size"] != item["size"]):
            raise HTTPException(409, "成果包与附件的文件路径冲突：" + item["path"])
        if item["role"] == "primary":
            prior["role"] = "primary"
        return
    if (len(merged) >= limits.max_files
            or sum(row[0]["size"] for row in merged.values()) + item["size"] > limits.max_unpacked):
        raise HTTPException(413, "合并后的成果文件数量或总大小超过限制")
    merged[key] = (item, data)


async def collect(rows, *, primary_ids=(), force_bundle=False, validate_standalone=False, limits=None):
    """Read authorized immutable attachments and return their complete bytes."""
    limits = limits or collections.validation_limits()
    if any(int(row.size or 0) > limits.max_bytes for row in rows):
        raise HTTPException(413, "成果文件超过大小限制")
    if sum(int(row.size or 0) for row in rows) > limits.max_unpacked:
        raise HTTPException(413, "成果总大小超过限制")
    bundles = [row for row in rows if row.filename.startswith("完整产出-")
               and row.filename.lower().endswith(".zip")]
    primary_ids = set(primary_ids)
    merged, original, original_paths, dependencies = {}, None, set(), []
    for row in bundles + [row for row in rows if row not in bundles]:
        data = await asyncio.to_thread(storage.get, row.storage_key, row.backend)
        if len(data) != row.size:
            raise HTTPException(422, "成果文件不完整，拒绝返回不完整成果")
        if validate_standalone:
            checked = await asyncio.to_thread(
                delivery_manifest.validate_bytes, row.filename, data, row.content_type)
            if checked.get("state") != "passed":
                raise HTTPException(422, "成果文件结构失效：" + row.filename)
        if row in bundles:
            parts, contents, online = await asyncio.to_thread(_describe_bundle, data, limits)
            dependencies.extend(online)
            for item, content in zip(parts, contents):
                _merge_file(merged, item, content, limits)
            if len(bundles) == 1:
                original, original_paths = data, {item["path"] for item in parts}
        else:
            dependencies.extend(await asyncio.to_thread(_online_dependencies, row.filename, data))
            role = "primary" if row.id in primary_ids else "supporting"
            item = await asyncio.to_thread(_file, row.filename, data, role, row.content_type)
            _merge_file(merged, item, data, limits)
    files = [item for item, _ in merged.values()]
    contents = [data for _, data in merged.values()]
    if not files:
        raise HTTPException(422, "成果包中没有文件")
    kind = "bundle" if force_bundle or bundles or len(files) > 1 else "file"
    # This also rejects cross-member file/directory collisions after merging.
    collections.clean_manifest({"source": "cloud", "sessionId": "archive",
        "revision": "verify", "kind": kind, "files": files}, limits=limits)
    if original is not None and original_paths == {item["path"] for item in files}:
        raw = original
    elif kind == "file":
        raw = contents[0]
    else:
        raw = await asyncio.to_thread(_bundle, files, contents)
    return {"files": files, "bytes": raw, "kind": kind,
            "externalDependencies": list(dict.fromkeys(dependencies))[:50]}
