"""Validated, per-turn image transport. Only staged uploads become image blocks.

Paths mentioned in a prompt are never inspected. The subprocess handoff contains
bounded metadata, not base64; the bridge rechecks containment and content before
sending pixels to an Agent that explicitly advertised image prompt support.
"""
from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

ENV_KEY = "SODUWORK_RUNNER_INPUT_IMAGES"
CFG_KEY = "_inputImages"
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 20 * 1024 * 1024
MAX_IMAGES = 20
# Hints for formats missing from some hosts' MIME databases, not an allowlist.
# Any declared image/* type can travel through the same handoff.
_IMAGE_TYPES = {
    ".heic": "image/heic", ".heif": "image/heif", ".avif": "image/avif",
    ".jxl": "image/jxl", ".jp2": "image/jp2", ".j2k": "image/jp2",
    ".raw": "image/x-raw", ".cr2": "image/x-canon-cr2", ".nef": "image/x-nikon-nef",
    ".arw": "image/x-sony-arw", ".dng": "image/x-adobe-dng", ".psd": "image/vnd.adobe.photoshop",
}


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


def _image_type(filename: str, content_type: str = "") -> str:
    declared = str(content_type or "").split(";", 1)[0].strip().lower()
    if re.fullmatch(r"image/[a-z0-9][a-z0-9.+-]*", declared):
        return {"image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg",
                "image/x-png": "image/png"}.get(declared, declared)
    hint = _IMAGE_TYPES.get(Path(filename).suffix.lower())
    if hint:
        return hint
    guessed, _ = mimetypes.guess_type(filename, strict=False)
    return guessed if guessed and guessed.startswith("image/") else ""


def _mime(data: bytes, filename: str = "", content_type: str = "") -> str:
    """Describe uploaded bytes without imposing a decoder/format allowlist.

    The selected Agent/model owns decoding. Keep familiar signature hints to
    correct mislabeled uploads, but do not reject ancillary chunks, trailing
    metadata or a new image format just because this transport cannot decode it.
    """
    if not data:
        raise ImageInputError("图片附件为空，请重新选择图片后发送")
    if data[:4] == b"\xe0\xa8\x91\xe7" and data[88:96] == b"Esafenet":
        raise ImageInputError("图片附件受加密保护，当前执行底座无法读取，请使用已获授权的可读图片")
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    hint = _image_type(filename, content_type)
    if hint:
        return hint
    raise ImageInputError("无法确定附件的图片类型，请重新选择图片后发送")


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
        content_type = _image_type(filename, item.get("contentType") or "")
        if not content_type:
            continue
        path = os.path.abspath(str(item.get("path") or ""))
        data = _read(path, root)
        path = os.path.realpath(path)
        mime = _mime(data, filename, content_type)
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
        mime = _mime(data, str(item.get("path") or ""), str(item.get("mimeType") or ""))
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
