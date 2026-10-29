"""Validated, per-turn image transport. Only staged uploads become image blocks.

Paths mentioned in a prompt are never inspected. The subprocess handoff contains
bounded metadata, not base64; the bridge rechecks containment and content before
sending pixels to an Agent that explicitly advertised image prompt support.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
import zlib
from pathlib import Path
from urllib.parse import urlsplit

ENV_KEY = "SODUWORK_RUNNER_INPUT_IMAGES"
CFG_KEY = "_inputImages"
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 20 * 1024 * 1024
MAX_IMAGES = 20
_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".heic", ".avif", ".tif", ".tiff"}


class ImageInputError(ValueError):
    pass


def transport_supported(llm: dict | None) -> bool:
    row = dict(llm or {})
    routing = row.get("imageRouting")
    if routing == "vision-fallback":
        # Fallback is implemented by SoduWork's proxy, not by an arbitrary vendor.
        return row.get("visionFallbackAvailable") is True and urlsplit(
            str(row.get("base") or "")).path.rstrip("/").endswith("/api/v1/ai-proxy/v1")
    return routing == "native" or "image" in (row.get("input") or [])


def model_fields(llm: dict | None) -> dict:
    """Copy explicit capabilities without inventing vision for unknown models."""
    row = dict(llm or {})
    out = {}
    if isinstance(row.get("input"), list):
        out["input"] = [value for value in ("text", "image") if value in row["input"]]
    if row.get("imageRouting") in ("native", "vision-fallback"):
        out["imageRouting"] = row["imageRouting"]
    if isinstance(row.get("visionFallbackAvailable"), bool):
        out["visionFallbackAvailable"] = row["visionFallbackAvailable"]
    if isinstance(row.get("capabilityProfile"), dict):
        out["capabilityProfile"] = row["capabilityProfile"]
    value = row.get("maxOutputTokens")
    if isinstance(value, int) and not isinstance(value, bool) and 1024 <= value <= 262144:
        out["maxOutputTokens"] = value
    if isinstance(row.get("configRevision"), str):
        out["configRevision"] = row["configRevision"]
    if isinstance(row.get("runtimeRevision"), str):
        out["runtimeRevision"] = row["runtimeRevision"]
    return out


def _mime(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        offset, width, height, ended, pixels = 8, 0, 0, False, False
        while offset + 12 <= len(data):
            size = struct.unpack(">I", data[offset:offset + 4])[0]
            end = offset + size + 12
            if end > len(data):
                break
            kind, content = data[offset + 4:offset + 8], data[offset + 8:offset + 8 + size]
            if zlib.crc32(kind + content) & 0xffffffff != struct.unpack(">I", data[end - 4:end])[0]:
                break
            if offset == 8 and kind == b"IHDR" and size == 13:
                width, height = struct.unpack(">II", content[:8])
            pixels = pixels or kind == b"IDAT"
            offset = end
            if kind == b"IEND" and size == 0:
                ended = offset == len(data)
                break
        if ended and pixels and width and height and width * height <= 100_000_000:
            return "image/png"
    elif len(data) >= 12 and data[:3] == b"\xff\xd8\xff" and data[-2:] == b"\xff\xd9":
        return "image/jpeg"
    elif len(data) >= 14 and data[:6] in (b"GIF87a", b"GIF89a") and data[-1:] == b";":
        width, height = struct.unpack("<HH", data[6:10])
        if width and height and width * height <= 100_000_000:
            return "image/gif"
    elif len(data) >= 20 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        if struct.unpack("<I", data[4:8])[0] + 8 == len(data) and data[12:16] in (b"VP8 ", b"VP8L", b"VP8X"):
            return "image/webp"
    raise ImageInputError("图片格式无效或不受支持，请使用完整的 PNG、JPEG、GIF 或 WebP 图片")


def _read(path: str, root: str) -> bytes:
    real_root = os.path.realpath(root)
    real = os.path.realpath(path)
    try:
        inside = os.path.commonpath((real_root, real)) == real_root and real != real_root
    except ValueError:
        inside = False
    if real_root != os.path.abspath(root) or not inside or os.path.islink(path) or not os.path.isfile(real):
        raise ImageInputError("图片附件不在当前会话的安全存档范围内")
    if os.path.getsize(real) > MAX_IMAGE_BYTES:
        raise ImageInputError("单张图片不能超过 8 MB，请压缩后重新上传")
    with open(real, "rb") as stream:
        data = stream.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise ImageInputError("单张图片不能超过 8 MB，请压缩后重新上传")
    return data


def prepare(cfg: dict | None, staged: list[dict], root: str) -> dict:
    """Called after trusted staging, for both first and follow-up turns."""
    fresh = dict(cfg or {})
    root = os.path.realpath(root)
    images, total = [], 0
    for item in staged:
        filename = str(item.get("name") or item.get("path") or "")
        content_type = str(item.get("contentType") or "").split(";", 1)[0].lower()
        if not content_type.startswith("image/") and Path(filename).suffix.lower() not in _EXTENSIONS:
            continue
        path = os.path.abspath(str(item.get("path") or ""))
        data = _read(path, root)
        path = os.path.realpath(path)
        mime = _mime(data)
        if content_type.startswith("image/") and content_type != mime and not (mime == "image/jpeg" and content_type == "image/jpg"):
            raise ImageInputError("图片内容与文件类型不一致，请重新上传原始图片")
        total += len(data)
        if total > MAX_TOTAL_BYTES or len(images) >= MAX_IMAGES:
            raise ImageInputError("本轮图片合计不能超过 20 MB 或 20 张，请分次发送")
        images.append({"path": path, "mimeType": mime, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    fresh[CFG_KEY] = images
    # Native Codex already owns its --image= argument implementation.
    fresh["images"] = [item["path"] for item in images]
    return fresh


def environment(cfg: dict | None, root: str) -> str:
    images = list((cfg or {}).get(CFG_KEY) or [])
    if not images:
        return ""
    value = {"root": os.path.realpath(root), "images": images}
    # Check before spawning; check again in the bridge to catch a replaced file.
    _blocks(value, encode=False)
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _blocks(value: dict, *, encode: bool = True) -> list[dict]:
    images = value.get("images")
    root = str(value.get("root") or "")
    if not root or not os.path.isabs(root) or not isinstance(images, list) or len(images) > MAX_IMAGES:
        raise ImageInputError("图片附件清单无效，请重新上传")
    blocks, total = [], 0
    for item in images:
        if not isinstance(item, dict):
            raise ImageInputError("图片附件清单无效，请重新上传")
        data = _read(str(item.get("path") or ""), root)
        mime = _mime(data)
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise ImageInputError("本轮图片合计不能超过 20 MB，请分次发送")
        if item.get("size") != len(data) or item.get("sha256") != hashlib.sha256(data).hexdigest() or item.get("mimeType") != mime:
            raise ImageInputError("图片附件已变化，请重新上传后重试")
        if encode:
            blocks.append({"type": "image", "mimeType": mime, "data": base64.b64encode(data).decode("ascii")})
    return blocks


def prompt(text: str, capabilities: dict, raw: str = "") -> list[dict]:
    content = [{"type": "text", "text": text}]
    if not raw:
        return content
    try:
        value = json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise ImageInputError("图片附件清单无效，请重新上传") from exc
    if not isinstance(value, dict):
        raise ImageInputError("图片附件清单无效，请重新上传")
    if (capabilities.get("promptCapabilities") or {}).get("image") is not True:
        raise ImageInputError("当前执行底座未声明图片输入能力，图片未发送；请切换支持图片输入的底座后重试，原附件已保留")
    return content + _blocks(value)
