"""Deterministic collection of files declared by one workflow node.

Repository jobs normally deliver Git evidence and must never be scanned or zipped as a
whole. Some Git-backed nodes (for example AI review) also declare one small decision
file. This module tracks those exact paths so terminal status can return them without
turning the repository into an attachment bundle.
"""
from __future__ import annotations

import os


_MAX_PATHS = 20
_LEGACY_MTIME_SLOP = 2.0


def _safe_relative(value: object) -> str:
    raw = str(value or "").strip().replace("\\", "/")
    if (not raw or raw.startswith("/") or os.path.isabs(raw)
            or (len(raw) > 1 and raw[1] == ":")):
        return ""
    parts = raw.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return ""
    return "/".join(parts)[:300]


def paths(outputs: object) -> list[str]:
    """Return bounded, unique file paths from a normalized output contract."""
    found: list[str] = []
    seen: set[str] = set()
    for raw in outputs if isinstance(outputs, list) else []:
        if not isinstance(raw, dict) or str(raw.get("kind") or "") not in {
                "file", "decision"}:
            continue
        path = _safe_relative(raw.get("path"))
        if path and path not in seen:
            found.append(path)
            seen.add(path)
        if len(found) >= _MAX_PATHS:
            break
    return found


def _file(root: str, relative: str) -> tuple[str, os.stat_result] | None:
    raw_root = str(root or "").strip()
    if not raw_root:
        return None
    base = os.path.realpath(raw_root)
    candidate = os.path.realpath(os.path.join(base, *relative.split("/")))
    try:
        if os.path.commonpath([base, candidate]) != base or not os.path.isfile(candidate):
            return None
        return candidate, os.stat(candidate)
    except (OSError, ValueError):
        return None


def baseline(root: str, declared_paths: list[str]) -> dict[str, list[int]]:
    """Capture small signatures for declared files that existed before dispatch."""
    result: dict[str, list[int]] = {}
    for relative in declared_paths[:_MAX_PATHS]:
        item = _file(root, relative)
        if item:
            _path, stat = item
            result[relative] = [int(stat.st_size), int(stat.st_mtime_ns)]
    return result


def changed_entries(run: dict) -> list[tuple[str, float]]:
    """Return declared paths created or changed by this run.

    Current runs carry an exact pre-dispatch baseline. Runs created by an older
    Runner can still recover paths from the workspace guard, but only when the file
    timestamp belongs to this execution window.
    """
    explicit = isinstance(run.get("expectedOutputPaths"), list)
    declared = [_safe_relative(value) for value in (
        run.get("expectedOutputPaths") or [])]
    declared = [value for value in declared if value][:_MAX_PATHS]
    if not declared and not explicit:
        guard = dict(run.get("workspaceGuard") or {})
        declared = [_safe_relative(value) for value in guard.get("allowedPaths") or []]
        declared = [value for value in declared if value][:_MAX_PATHS]
    before = dict(run.get("expectedOutputBaseline") or {})
    started = float(run.get("started") or run.get("firstStarted") or 0)
    if not explicit and not started:
        return []
    result: list[tuple[str, float]] = []
    for relative in declared:
        item = _file(str(run.get("ws") or ""), relative)
        if not item:
            continue
        _path, stat = item
        signature = [int(stat.st_size), int(stat.st_mtime_ns)]
        if explicit:
            old = before.get(relative)
            if isinstance(old, (list, tuple)) and list(old[:2]) == signature:
                continue
        elif started and float(stat.st_mtime) < started - _LEGACY_MTIME_SLOP:
            continue
        result.append((relative, float(stat.st_mtime)))
    result.sort(key=lambda item: (-(item[1] or 0), item[0]))
    return result
