"""Identify old ACP plan announcements in their original desktop Runner stream."""

import hashlib
import json
import re

from . import native_history_archive as archive


_HEADER = re.compile(r"===== 第 ([1-9][0-9]*) 段 · [0-9]{2}:[0-9]{2}:[0-9]{2} · "
                     r"--soduwork-session [^\s]* --soduwork-mode [^\s]+ =====")


def _plan_hash(part):
    # The old bridge omitted BOTH keys for plan notifications. Real tool_call
    # always wrote callId and toolKind, even if the ACP peer supplied empty IDs.
    state = part.get("state")
    if set(part) != {"tool", "state"} or not isinstance(state, dict) or set(state) != {"input"}:
        return ""
    args = state["input"]
    if not isinstance(args, dict) or set(args) != {"command"}:
        return ""
    command = args["command"]
    if not isinstance(command, str) or not 0 < len(command) <= 300:
        return ""
    return hashlib.sha256(command.encode()).hexdigest()


def _plans(lines, meta):
    plans = []
    segment = offset = 0
    session = ""
    header_expected = windows_text = False
    for line in lines:
        if line in (b"\r\n", b"\n"):
            if header_expected:
                raise ValueError("Unexpected empty line in ACP stdout")
            header_expected = True
            continue
        if header_expected:
            header = _HEADER.fullmatch(line.decode().rstrip("\r\n"))
            if not header or (segment and not session):
                raise ValueError("Missing ACP segment header")
            header_expected = False
            segment, offset, session = int(header[1]), 0, ""
            # _append_raw writes in text mode. Its own header identifies the
            # host newline. Restore exactly the bytes counted by local_spool.
            windows_text = line.endswith(b"\r\n")
            continue
        if not segment or not line.endswith(b"\n") or (windows_text and not line.endswith(b"\r\n")):
            raise ValueError("Incomplete ACP stream")
        offset += len(line) - int(windows_text)
        event = json.loads(line)
        if event.get("type") == "session":
            if session or not isinstance(event.get("sessionID"), str) or not event["sessionID"]:
                raise ValueError("Ambiguous ACP session")
            session = event["sessionID"]
        part = event.get("part")
        if event.get("type") == "tool_use" and isinstance(part, dict) and part.get("tool") == "Plan":
            if not session or len(plans) >= 4096:
                raise ValueError("Unbound ACP plan")
            plans.append([segment, offset, _plan_hash(part) if set(event) == {"type", "part"} else ""])
    offsets = meta["stream"]["offsets"]
    if (header_expected or not session or session != meta["cliSid"] or segment != meta["segment"]
            or offsets.get("err") != 0 or offsets.get("out") != offset):
        raise ValueError("Incomplete ACP archive")
    return plans


def lookup(store, request):
    try:
        root, file, before, meta, envelope = archive.generation(
            store, request.get("ref"), request.get("revision"), request.get("adapterId"))
        if meta.get("state") not in {"done", "failed", "interrupted", "stopped"}:
            return {}
        # raw.log is bounded at 8 MiB by local_base. A truncation notice,
        # absent line, changed generation or unrecognised producer fails closed.
        plans = _plans(archive.lines(root, file.parent / "raw.log", 8 * 1024 * 1024), meta)
        return {**envelope, "plans": plans} if archive.stamp(file.lstat()) == before else {}
    except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError, RecursionError, RuntimeError):
        return {}
