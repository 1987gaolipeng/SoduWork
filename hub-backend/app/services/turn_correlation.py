"""Non-secret admission identities bind archived output to the exact accepted turn."""
import re

_KEY = re.compile(r"(?:comment|dispatch):[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
TERMINAL = {"done", "failed", "stopped", "interrupted", "cancelled", "canceled"}


def key(value):
    return value if isinstance(value, str) and _KEY.fullmatch(value) else ""


def stamp(run, event):
    event["round"] = max(1, int(run.get("round") or 1))
    admission = key(run.get("admissionKey"))
    if admission:
        event["admissionKey"] = admission
    else:
        event.pop("admissionKey", None)
    start = run.get("admissionStartSeq")
    if admission and type(start) is int and 0 <= start <= int(run.get("seq") or 0):
        event["admissionStartSeq"] = start
    else:
        event.pop("admissionStartSeq", None)
    return event


def public(event):
    admission = key(event.get("admissionKey"))
    if not admission:
        return {}
    result = {"admissionKey": admission, "turnCorrelationVersion": 1}
    start = event.get("admissionStartSeq")
    if type(start) is int and start >= 0:
        result["admissionStartSeq"] = start
    if event.get("kind") == "turn-end" and event.get("turnState") in TERMINAL:
        result["turnState"] = event["turnState"]
    return result


def terminal(run):
    admission, state = key(run.get("admissionKey")), run.get("state")
    identity = [admission, max(1, int(run.get("round") or 1)), state]
    if not admission or state not in TERMINAL or run.get("turnEndIdentity") == identity:
        return None
    run["turnEndIdentity"] = identity
    return stamp(run, {"kind": "turn-end", "text": "", "turnState": state})
