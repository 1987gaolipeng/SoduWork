"""Public module behavior and service contracts."""
import json

# Candidate source fields per Envelope field, ordered by priority and matched case-insensitively.
_ALIASES: dict[str, tuple[str, ...]] = {
    "external_id": ("external_id", "id", "bugid", "bug_id", "bugcode", "code", "no", "number", "key"),
    "title": ("title", "summary", "name", "subject", "bugtitle", "bugname"),
    "note": ("note", "description", "desc", "detail", "content", "steps", "reproduce",
             "reproduce_steps", "bugdesc"),
    "status": ("status", "state", "bugstatus", "stage"),
    "assignee": ("assignee", "assign_to", "assignto", "handler", "owner", "developer",
                 "dev", "fixuser", "fix_user", "responsible", "duty"),
    "ext_repo": ("ext_repo", "repo", "repository", "project", "projectname", "project_name",
                 "module", "product", "system", "systemname", "app", "component"),
    "severity": ("severity", "level", "priority", "buglevel", "seriousness", "grade"),
    "external_url": ("external_url", "url", "link", "weburl", "web_url", "detailurl"),
    "reporter": ("reporter", "creator", "submitter", "author", "founder", "createby", "create_by"),
}

# Normalize Chinese and English statuses; unknown values become todo, never inferred done.
_ST_DOING = ("doing", "in progress", "in-progress", "wip", "processing", "fixing",
             "处理中", "进行中", "修复中", "已确认")
_ST_DONE = ("done", "closed", "resolved", "fixed", "verified", "已修复", "已关闭",
            "已解决", "已验证", "关闭")
_ST_CANCEL = ("cancel", "canceled", "cancelled", "rejected", "invalid", "wontfix",
              "已取消", "已拒绝", "无效", "不修复")

_TEXT_KEYS = ("note",)          # Apply consistent length limits to potentially large fields.


def _flat(d: dict) -> dict:
    """Normalize keys by lowercasing and removing underscores and hyphens for alias matching."""
    out = {}
    for k, v in (d or {}).items():
        out[str(k).strip().lower().replace("_", "").replace("-", "")] = v
    return out


def _person(v) -> str | None:
    """Resolve a person from a string or an object containing username, account, name, realName, or
    id.
    """
    if v is None:
        return None
    if isinstance(v, dict):
        for k in ("username", "account", "name", "realname", "loginname", "id", "code"):
            for kk, vv in v.items():
                if str(kk).strip().lower().replace("_", "") == k and vv:
                    return str(vv).strip()
        return None
    if isinstance(v, list):
        return _person(v[0]) if v else None
    s = str(v).strip()
    return s or None


def _dig(src: dict, path: str):
    """Resolve a dotted path such as fixUser.account; return None if any segment is missing."""
    cur = src
    for part in str(path).split("."):
        if not isinstance(cur, dict):
            return None
        flat = _flat(cur)
        key = part.strip().lower().replace("_", "").replace("-", "")
        if key not in flat:
            return None
        cur = flat[key]
    return cur


def _pick(raw: dict, flat: dict, field: str, field_map: dict):
    """Prefer configured fieldMap paths, then try built-in aliases."""
    mapped = (field_map or {}).get(field)
    if mapped:
        v = _dig(raw, mapped)
        if v not in (None, ""):
            return v
    for alias in _ALIASES.get(field, ()):
        if alias in flat and flat[alias] not in (None, ""):
            return flat[alias]
    return None


def _norm_status(v) -> str:
    s = str(v or "").strip().lower()
    if not s:
        return "todo"
    if any(k in s for k in _ST_CANCEL):
        return "cancel"
    if any(k in s for k in _ST_DONE):
        return "done"
    if any(k in s for k in _ST_DOING):
        return "doing"
    return "todo"          # Map new, awaiting-fix, and unknown states to todo.


def _items_of(data):
    """Normalize a single record, common list wrappers, or a bare array to an item list."""
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []
    for k in ("items", "data", "list", "records", "rows", "bugs"):
        v = data.get(k)
        if isinstance(v, list):
            return v
        if isinstance(v, dict) and (v.get("list") or v.get("records")):
            inner = v.get("list") or v.get("records")
            if isinstance(inner, list):
                return inner
    return [data]


class TestPlatConnector:
    type = "testplat"
    # This push-only adapter omits scheduled so the poller does not fetch it.

    def to_envelope(self, item: dict, field_map: dict | None = None) -> dict | None:
        if not isinstance(item, dict):
            return None
        flat = _flat(item)
        fm = field_map or {}
        ext_id = _pick(item, flat, "external_id", fm)
        if ext_id in (None, ""):
            return None                    # Discard records without a stable ID because idempotent upsert is impossible.
        note = _pick(item, flat, "note", fm) or ""
        env = {
            "external_id": str(ext_id),
            "external_url": (_pick(item, flat, "external_url", fm) or None),
            "title": str(_pick(item, flat, "title", fm) or "未命名 bug")[:200],
            "note": str(note)[:2000] if "note" in _TEXT_KEYS else str(note),
            "status": _norm_status(_pick(item, flat, "status", fm)),
            "assignee": _person(_pick(item, flat, "assignee", fm)),
            "ext_repo": (str(_pick(item, flat, "ext_repo", fm)).strip()
                         if _pick(item, flat, "ext_repo", fm) not in (None, "") else None),
            "severity": (str(_pick(item, flat, "severity", fm)).strip()
                         if _pick(item, flat, "severity", fm) not in (None, "") else None),
            "reporter": _person(_pick(item, flat, "reporter", fm)),
            # Label issues visibly so they remain distinguishable from ordinary tasks.
            "source_label": "测试平台 bug #" + str(ext_id),
        }
        return env

    def parse_webhook(self, headers: dict, body: bytes, config: dict | None = None) -> list[dict]:
        """Accept optional integration config for fieldMap. The ingest layer inspects signatures to
        preserve older two-argument adapters.
        """
        try:
            data = json.loads(body or b"{}")
        except Exception:  # noqa: BLE001
            return []
        fm = (config or {}).get("fieldMap") or {}
        if not isinstance(fm, dict):
            fm = {}
        out = []
        for it in _items_of(data):
            env = self.to_envelope(it, fm)
            if env:
                out.append(env)
        return out
