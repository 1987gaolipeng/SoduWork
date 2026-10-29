"""Verify and restore a portable conversation workspace before any Agent starts.

This is a file/context contract, not a second execution engine. Hub authenticates
the request and owns dispatch idempotency; a Runner restores into a private new
directory and then uses the normal execution lifecycle.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import stat
import tempfile
import time
import unicodedata
import zipfile

SCHEMA = "soduwork.workspace-handoff/v1"
MAX_FILES = 4000
MAX_BYTES = 96 * 1024 * 1024
MAX_TRANSCRIPT = 2 * 1024 * 1024
MAX_ARCHIVE = MAX_BYTES + MAX_TRANSCRIPT + 1024 * 1024
_DIGEST = re.compile(r"[a-f0-9]{64}")
_PRIVATE = {".git", ".svn", ".hg", "node_modules", ".venv", "venv", "__pycache__",
            ".ssh", ".aws", ".azure", ".config", ".soduwork", ".pi", ".codex", ".claude", ".opencode"}
_SECRET = re.compile(r"^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\..*)?|"
                     r"id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$|\.(?:pem|p12|pfx|key)$", re.I)


def _path_key(value: str) -> str:
    # Match the desktop contract. casefold would reject distinct names such as
    # Straße and STRASSE only after the user had already uploaded the snapshot.
    return unicodedata.normalize("NFC", value).lower()


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("交接清单包含重复字段")
        result[key] = value
    return result


def portable_path(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 500 or "\\" in value:
        raise ValueError("交接文件路径无效")
    parts = value.split("/")
    if any(not p or p in {".", ".."} or re.search(r'[<>:"|?*\x00-\x1f\x7f]', p)
           or p[-1:] in {".", " "} or re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", p, re.I)
           for p in parts):
        raise ValueError("交接文件含不安全或不兼容路径")
    if any(p.lower() in _PRIVATE for p in parts) or _SECRET.search(parts[-1]):
        raise ValueError("交接包不能包含本机凭据或运行缓存")
    return value


def _source(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {"sessionId", "adapterId", "modelName", "title", "goal", "messages"}:
        raise ValueError("交接会话清单无效")
    for name, limit in {"sessionId": 160, "adapterId": 40, "modelName": 200, "title": 200, "goal": 16000}.items():
        if not isinstance(value[name], str) or len(value[name]) > limit:
            raise ValueError("交接会话字段超出范围")
    if not value["sessionId"] or not isinstance(value["messages"], list):
        raise ValueError("交接缺少原会话")
    for row in value["messages"]:
        if not isinstance(row, dict) or set(row) != {"role", "text", "at"} or row["role"] not in {"user", "assistant"} \
                or not isinstance(row["text"], str) or type(row["at"]) not in {int, float} \
                or not math.isfinite(row["at"]):
            raise ValueError("交接消息格式无效")
    return value


def validate(data: bytes, expected_sha256: str) -> dict:
    if not isinstance(data, bytes) or not data or len(data) > MAX_ARCHIVE:
        raise ValueError("交接包为空或超过上限")
    if not _DIGEST.fullmatch(str(expected_sha256)) or hashlib.sha256(data).hexdigest() != expected_sha256:
        raise ValueError("交接包完整性校验失败")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_FILES + 1 or sum(x.file_size for x in infos) > MAX_BYTES + MAX_TRANSCRIPT:
                raise ValueError("交接文件过多或解压后超过上限")
            names = set()
            for item in infos:
                if item.is_dir() or item.flag_bits & 1 or item.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                    raise ValueError("交接包包含不支持的条目")
                kind = stat.S_IFMT(item.external_attr >> 16)
                if kind not in {0, stat.S_IFREG}:
                    raise ValueError("交接包包含链接或特殊文件")
                if item.filename != "manifest.json":
                    if not item.filename.startswith("workspace/"):
                        raise ValueError("交接包包含未声明的区域")
                    portable_path(item.filename[len("workspace/"):])
                key = _path_key(item.filename)
                if key in names:
                    raise ValueError("交接包包含冲突文件名")
                names.add(key)
            info = archive.getinfo("manifest.json")
            if info.file_size > MAX_TRANSCRIPT:
                raise ValueError("交接记录超过上限")
            manifest = json.loads(archive.read(info).decode("utf-8"), object_pairs_hook=_unique_object)
            if not isinstance(manifest, dict) or set(manifest) != {"schema", "source", "files", "excluded"} \
                    or manifest.get("schema") != SCHEMA:
                raise ValueError("交接版本不受支持")
            _source(manifest.get("source"))
            excluded = manifest["excluded"]
            if not isinstance(excluded, list) or any(not isinstance(row, dict)
                    or set(row) != {"path", "reason"} or not isinstance(row["path"], str)
                    or row["reason"] not in {"link", "runtime-or-credentials", "credentials"} for row in excluded):
                raise ValueError("交接排除清单无效")
            files = manifest.get("files")
            if not isinstance(files, list) or len(files) > MAX_FILES:
                raise ValueError("交接文件清单无效")
            expected_names, total = {"manifest.json"}, 0
            for row in files:
                if not isinstance(row, dict) or set(row) != {"path", "size", "sha256"}:
                    raise ValueError("交接文件记录无效")
                name = "workspace/" + portable_path(row["path"])
                if name in expected_names or type(row["size"]) is not int or row["size"] < 0 or not _DIGEST.fullmatch(str(row["sha256"])):
                    raise ValueError("交接文件记录无效")
                expected_names.add(name)
                info = archive.getinfo(name)
                total += info.file_size
                if info.file_size != row["size"] or total > MAX_BYTES:
                    raise ValueError("交接文件大小不符")
                if hashlib.sha256(archive.read(info)).hexdigest() != row["sha256"]:
                    raise ValueError("交接文件校验失败")
            if {x.filename for x in infos} != expected_names:
                raise ValueError("交接包存在遗漏或未声明文件")
            # A file must never also be the parent directory of another file.
            folded_names = {_path_key(name) for name in expected_names}
            for name in folded_names:
                parts = name.split("/")
                if any("/".join(parts[:i]) in folded_names for i in range(1, len(parts))):
                    raise ValueError("交接文件与目录冲突")
            return manifest
    except (KeyError, zipfile.BadZipFile, UnicodeDecodeError, json.JSONDecodeError, RuntimeError, OverflowError) as exc:
        raise ValueError("交接包损坏或清单不完整") from exc


@contextmanager
def _lock(file: Path):
    # Kernel-owned locks release on process death; no stale PID file can prevent
    # recovery after a machine restart or upload retry.
    with file.open("a+b") as handle:
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise ValueError("相同交接正在恢复，请重试原请求") from exc
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _publish_workspace(staged: Path, target: Path) -> None:
    # Windows scanners can briefly hold newly-written files without delete
    # sharing. Keep the atomic directory publication; never replace it with a
    # partial copy, change permissions, or retry an already-existing target.
    delays = (.05, .1, .2, .4, .8)
    for attempt in range(len(delays) + 1):
        try:
            staged.rename(target)
            return
        except OSError as exc:
            if (getattr(exc, "winerror", None) not in {5, 32, 33}
                    or attempt == len(delays) or target.exists()):
                raise
            time.sleep(delays[attempt])


def restore(data: bytes, expected_sha256: str, parent: Path, transfer_id: str) -> dict:
    """Publish a complete new workspace; retries never overwrite live work."""
    if not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", str(transfer_id)):
        raise ValueError("交接标识无效")
    manifest = validate(data, expected_sha256)
    parent = Path(parent).resolve()
    parent.mkdir(parents=True, exist_ok=True)
    target = parent / ("handoff-" + transfer_id)
    marker = target / ".soduwork" / "handoff.json"
    with _lock(parent / (".handoff-" + transfer_id + ".lock")):
        if target.is_symlink() or getattr(target, "is_junction", lambda: False)():
            raise ValueError("交接目录不能是链接")
        if target.exists():
            if any(p.is_symlink() or getattr(p, "is_junction", lambda: False)()
                   for p in (marker.parent, marker)):
                raise ValueError("交接记录不能是链接")
            try:
                saved = json.loads(marker.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                raise ValueError("交接目标已存在，不能覆盖") from exc
            if saved.get("sha256") != expected_sha256 or saved.get("transferId") != transfer_id:
                raise ValueError("同一交接标识不能替换内容")
            return {"path": str(target), "reused": True, "manifest": manifest}
        with tempfile.TemporaryDirectory(prefix=".handoff-staging-", dir=parent) as temporary:
            staged = Path(temporary) / "workspace"
            staged.mkdir()
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                for row in manifest["files"]:
                    destination = staged.joinpath(*row["path"].split("/"))
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(archive.read("workspace/" + row["path"]))
            control = staged / ".soduwork"
            control.mkdir()
            (control / "handoff.json").write_text(json.dumps({"transferId": transfer_id,
                "sha256": expected_sha256, "source": manifest["source"]}, ensure_ascii=False), encoding="utf-8")
            _publish_workspace(staged, target)
    return {"path": str(target), "reused": False, "manifest": manifest}
