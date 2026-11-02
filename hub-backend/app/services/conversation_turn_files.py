"""Bounded, content-addressed material for one idempotent conversation turn."""
import base64
import binascii
import hashlib
import re
from fastapi import HTTPException

LIMIT = 16 * 1024 * 1024


def decode(rows):
    if not isinstance(rows, list) or len(rows) > 20:
        raise HTTPException(422, "每轮最多追加 20 份文件")
    files, manifest, names, total = [], [], set(), 0
    for row in rows:
        if not isinstance(row, dict) or set(row) - {"name", "data", "contentType"}:
            raise HTTPException(422, "附件格式不正确")
        name, data, mime = row.get("name"), row.get("data"), row.get("contentType", "application/octet-stream")
        if (not isinstance(name, str) or not name or len(name) > 200 or name != name.strip()
                or name.endswith(".") or re.search(r'[\\/:*?"<>|\x00-\x1f\x7f]', name)
                or name.casefold() in names or name in {".", ".."}
                or re.fullmatch(r"(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", name)):
            raise HTTPException(422, "附件名称无效或重复，请重命名后重试")
        if not isinstance(data, str) or len(data) > (LIMIT * 4 // 3 + 4):
            raise HTTPException(413, "每轮追加文件合计不能超过 16MB")
        if not isinstance(mime, str) or len(mime) > 200 or re.search(r'[\x00-\x1f\x7f]', mime):
            raise HTTPException(422, "附件类型无效")
        try:
            content = base64.b64decode(data, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise HTTPException(422, "附件内容无效") from exc
        total += len(content)
        if not content or total > LIMIT:
            raise HTTPException(413, "附件不能为空，合计不能超过 16MB")
        names.add(name.casefold())
        files.append((name, content, mime))
        manifest.append({"name": name, "contentType": mime, "size": len(content),
                         "sha256": hashlib.sha256(content).hexdigest()})
    return files, manifest
