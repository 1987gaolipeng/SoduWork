# -*- coding: utf-8 -*-
"""Shared Runner/Hub bin1 framing: one-byte kind, four-byte big-endian metadata length, UTF-8 JSON
metadata, then raw payload. Kind 1 carries terminal output and kind 2 artifact RPC chunks. Use
binary only when both peers advertise bin1; otherwise retain base64 JSON compatibility.
"""
from __future__ import annotations

import json
import struct

CAP_BIN1 = "bin1"
KIND_TERM_OUT = 1
KIND_REPLY_CHUNK = 2

_MAX_META = 64 * 1024


def encode(kind: int, meta: dict, payload: bytes = b"") -> bytes:
    head = json.dumps(meta or {}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(head) > _MAX_META:
        raise ValueError("二进制帧的 meta 过大")
    return struct.pack(">BI", int(kind), len(head)) + head + bytes(payload or b"")


def decode(buf: bytes) -> tuple[int, dict, bytes]:
    data = bytes(buf or b"")
    if len(data) < 5:
        raise ValueError("二进制帧太短")
    kind, meta_len = struct.unpack(">BI", data[:5])
    if meta_len > _MAX_META or 5 + meta_len > len(data):
        raise ValueError("二进制帧的 meta 长度不合法")
    meta = json.loads(data[5:5 + meta_len].decode("utf-8") or "{}")
    if not isinstance(meta, dict):
        raise ValueError("二进制帧的 meta 必须是对象")
    return int(kind), meta, data[5 + meta_len:]
