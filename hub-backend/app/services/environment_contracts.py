"""Declarative environment/target configuration and preflight identity.

Database ownership, permission scope, promotion graph lookup and actual Runner
probes stay in environment_service. Provider-specific validation is delegated to
the existing release_providers registry when the contract is evaluated.
"""
from __future__ import annotations

import re

from .. import automation_models as am, models
from . import preflight_evidence

_KEY = re.compile(r"^[a-z][a-z0-9-]{1,62}$")
_SECRET_WORD = re.compile(r"password|passwd|token|secret|private.?key|api.?key", re.I)


def _text(value, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _contains_secret(value, path: str = "") -> str:
    if isinstance(value, dict):
        for key, child in value.items():
            here = f"{path}.{key}" if path else str(key)
            if _SECRET_WORD.search(str(key)):
                return here
            hit = _contains_secret(child, here)
            if hit:
                return hit
    elif isinstance(value, list):
        for idx, child in enumerate(value):
            hit = _contains_secret(child, f"{path}[{idx}]")
            if hit:
                return hit
    return ""


def _selector(value) -> dict:
    raw = dict(value or {}) if isinstance(value, dict) else {}
    tags = []
    for item in raw.get("tags") or []:
        tag = _text(item, 40).lower()
        if tag and tag not in tags:
            tags.append(tag)
    runner_ids = []
    for item in raw.get("runnerIds") or []:
        runner_id = _text(item, 80)
        if runner_id and runner_id not in runner_ids:
            runner_ids.append(runner_id)
    out = {"tags": tags[:20]}
    if runner_ids:
        out["runnerIds"] = runner_ids[:20]
    return out


def promotion_policy(value) -> dict:
    """Single interpreter for environment-promotion policy; names and categories carry no execution
    semantics.
    """
    raw = dict(value or {}) if isinstance(value, dict) else {}
    requires = []
    for item in raw.get("requires") or []:
        key = _text(item, 64).lower()
        if not _KEY.fullmatch(key):
            raise ValueError(f"前置环境标识不合法：{key or '空'}")
        if key not in requires:
            requires.append(key)
    return {
        "autoStart": bool(raw.get("autoStart")),
        "requires": requires[:30],
        "requiresApproval": bool(raw.get("requiresApproval")),
        "requiresAcceptance": bool(raw.get("requiresAcceptance")),
        "marksDelivery": bool(raw.get("marksDelivery")),
    }


def _argv(value, *, required: bool = False) -> list[str]:
    if not isinstance(value, list):
        if required:
            raise ValueError("部署命令必须是参数数组，不能是一整段 shell 字符串")
        return []
    out = [_text(x, 500) for x in value[:80]]
    if required and (not out or not out[0]):
        raise ValueError("部署命令不能为空")
    if any(not x for x in out):
        raise ValueError("部署命令参数不能有空项")
    return out


def _headers(value) -> dict:
    """Normalize assertion headers to bounded string pairs, including authentication headers."""
    out = {}
    for k, v in list((value or {}).items() if isinstance(value, dict) else [])[:12]:
        key = _text(k, 60)
        if key:
            out[key] = _text(v, 400)
    return out


def _checks(value) -> list[dict]:
    """Resolve deployment assertions shared by Runner-local and adapter-based publication.
    Configure each assertion with its environment and deployment entry point rather than
    duplicating it in plugins. A successful HTTP status proves reachability, not that the
    intended change was deployed; support request methods, headers, bodies, and
    contains/notContains response checks."""
    out = []
    for raw in (value or [])[:20]:
        if not isinstance(raw, dict):
            continue
        kind = _text(raw.get("type"), 24).lower()
        name = _text(raw.get("name"), 80) or ("HTTP 探活" if kind == "http" else "命令检查")
        timeout = min(120, max(1, int(raw.get("timeoutSeconds") or 15)))
        if kind == "http":
            url = _text(raw.get("url"), 800)
            if not url.startswith(("http://", "https://")):
                raise ValueError(f"{name} 的探活地址必须以 http:// 或 https:// 开头")
            method = (_text(raw.get("method"), 10) or "GET").upper()
            if method not in {"GET", "POST", "PUT", "HEAD", "DELETE"}:
                raise ValueError(f"{name} 的请求方法不支持：{method}")
            item = {"type": "http", "name": name, "url": url, "method": method,
                    "expectStatus": int(raw.get("expectStatus") or 200),
                    "timeoutSeconds": timeout}
            # Optional fields affect behavior only when configured, preserving older records.
            if raw.get("headers"):
                item["headers"] = _headers(raw.get("headers"))
            if raw.get("body"):
                item["body"] = _text(raw.get("body"), 4000)
            if raw.get("contains"):
                item["contains"] = _text(raw.get("contains"), 200)
            if raw.get("notContains"):
                item["notContains"] = _text(raw.get("notContains"), 200)
            # Allow configured readiness retries after publication.
            retries = min(10, max(0, int(raw.get("retries") or 0)))
            if retries:
                item["retries"] = retries
                item["intervalSeconds"] = min(60, max(1, int(raw.get("intervalSeconds") or 5)))
            out.append(item)
        elif kind == "command":
            out.append({"type": "command", "name": name, "argv": _argv(raw.get("argv"), required=True),
                        "timeoutSeconds": timeout})
        elif kind == "screenshot":
            # Hub captures screenshot receipts through receipt_shot; required defaults to True.
            # A missing required receipt blocks verification; optional screenshots must be explicitly configured.
            url = _text(raw.get("url"), 800)
            if not url.startswith(("http://", "https://")):
                raise ValueError(f"{name} 的截图地址必须以 http:// 或 https:// 开头")
            out.append({"type": "screenshot", "name": name or "上线回执截图",
                        "url": url, "required": bool(raw.get("required", True))})
        else:
            raise ValueError(f"不支持的健康检查类型：{kind or '空'}")
    return out


def _rollback(value, *, command_required: bool = True) -> dict:
    raw = dict(value or {}) if isinstance(value, dict) else {}
    mode = _text(raw.get("mode"), 20).lower() or "manual"
    if mode not in ("manual", "automatic"):
        raise ValueError("回滚方式只能是 manual 或 automatic")
    argv = _argv(raw.get("argv"))
    if mode == "automatic" and command_required and not argv:
        raise ValueError("自动回滚必须配置可执行的回滚命令")
    return {"mode": mode, **({"argv": argv} if argv else {})}


def effective_rollback(env: am.Environment | None,
                       target: am.DeploymentTarget | None) -> dict:
    """Resolve the environment policy without letting target defaults weaken it."""
    environment = dict(getattr(env, "rollback", None) or {})
    concrete = dict(getattr(target, "rollback", None) or {})
    if environment.get("mode") == "automatic":
        argv = list(concrete.get("argv") or environment.get("argv") or [])
        return {"mode": "automatic", **({"argv": argv} if argv else {})}
    return concrete or environment or {"mode": "manual"}


def _target_config(value, provider: str = "runner-command") -> dict:
    raw = dict(value or {}) if isinstance(value, dict) else {}
    leaked = _contains_secret(raw)
    if leaked:
        raise ValueError(f"{leaked} 看起来是凭据；请改用密钥引用")
    if provider != "runner-command":
        # Provider-specific configuration is validated by its release adapter.
        # Enforce the shared no-plaintext-credentials rule through release_providers.
        from . import release_providers
        why = release_providers.validate(provider, raw)
        if why:
            raise ValueError(why)
        return _channel_config(provider, raw)
    env = {}
    for key, val in dict(raw.get("env") or {}).items():
        k = _text(key, 80)
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k):
            raise ValueError(f"环境变量名不合法：{k}")
        env[k] = _text(val, 1000)
    config = {
        "argv": _argv(raw.get("argv"), required=True),
        "timeoutSeconds": min(3600, max(10, int(raw.get("timeoutSeconds") or 900))),
        "env": env,
        "cwd": "repo",  # Allow repository-root-relative locations only; Runners resolve their own roots instead of receiving server paths.
    }
    upload = raw.get("clientReleaseUpload")
    if upload is not None:
        if isinstance(upload, bool):
            config["clientReleaseUpload"] = {"enabled": upload}
        elif isinstance(upload, dict):
            unknown = set(upload) - {"enabled", "baseUrl"}
            if unknown:
                raise ValueError(
                    "clientReleaseUpload has unsupported fields: %s" %
                    ", ".join(sorted(str(x) for x in unknown)))
            item = {"enabled": bool(upload.get("enabled", True))}
            base_url = _text(upload.get("baseUrl"), 800).rstrip("/")
            if base_url:
                from urllib.parse import urlsplit
                parsed = urlsplit(base_url)
                if (parsed.scheme not in {"http", "https"} or not parsed.netloc
                        or parsed.username or parsed.password or parsed.query or parsed.fragment):
                    raise ValueError(
                        "clientReleaseUpload.baseUrl must be an HTTP(S) URL without credentials or query parameters")
                item["baseUrl"] = base_url
            config["clientReleaseUpload"] = item
        else:
            raise ValueError("clientReleaseUpload must be an object or boolean")
    return config


def target_probe_fingerprint(row: am.DeploymentTarget, env: am.Environment | None,
                             repo: models.Repo | None,
                             refs: dict[str, am.SecretReference] | None = None) -> str:
    """Fingerprint everything that can change what the probe actually proves."""
    refs = refs or {}
    secret_facts = {}
    for env_name, ref_id in sorted(dict(row.secret_refs or {}).items()):
        ref = refs.get(str(ref_id))
        secret_facts[str(env_name)] = {
            "id": str(ref_id), "provider": str(ref.provider if ref else ""),
            "locator": str(ref.locator if ref else ""),
            "enabled": bool(ref.enabled) if ref else False,
        }
    payload = {
        "provider": row.provider, "config": dict(row.config or {}),
        "secretRefs": secret_facts,
        "runnerSelector": {
            "environment": dict((env.runner_selector if env else {}) or {}),
            "target": dict(row.runner_selector or {}),
        },
        "healthChecks": [*list((env.health_checks if env else []) or []),
                         *list(row.health_checks or [])],
        "rollback": effective_rollback(env, row),
        "repository": {
            "id": str(row.repo_id or ""), "gitUrl": str(repo.git_url if repo else ""),
            "targetBranch": str((repo.merge_branch or repo.default_branch) if repo else ""),
        },
    }
    return preflight_evidence.fingerprint(payload)


def repo_probe_fingerprint(repo: models.Repo) -> str:
    return preflight_evidence.fingerprint({
        "scm": str(repo.scm or "git"), "gitUrl": str(repo.git_url or ""),
        "targetBranch": str(repo.merge_branch or repo.default_branch or ""),
        "gerritBase": str(repo.gerrit_base or ""),
    })


def _channel_config(provider: str, raw: dict) -> dict:
    """Normalize non-Runner provider configuration to a small, stable schema."""
    if provider == "cicd-mcp":
        services = []
        for item in (raw.get("services") or [])[:20]:
            if isinstance(item, dict) and item.get("service"):
                services.append({"service": _text(item.get("service"), 120),
                                 "branch": _text(item.get("branch"), 120)})
            elif isinstance(item, (list, tuple)) and item:
                services.append({"service": _text(item[0], 120),
                                 "branch": _text(item[1] if len(item) > 1 else "", 120)})
        out = {"customer": _text(raw.get("customer"), 120),
               "environment": _text(raw.get("environment"), 120)}
        if services:
            out["services"] = services
        url = _text(raw.get("mcpUrl"), 300)
        if url:
            out["mcpUrl"] = url
        return out
    return dict(raw)
