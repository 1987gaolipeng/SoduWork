"""Provider-independent capability contract. Scenarios declare stable requirements and executors
report verified capabilities. Treat undetected capabilities as unavailable; installed browsers
alone do not establish browser or desktop automation bridges.
"""
from __future__ import annotations

import copy
import os
import re
import shutil
import subprocess
import threading
import time
from typing import Iterable


SCHEMA_VERSION = 3

CATALOG: dict[str, dict[str, str]] = {
    "files": {"label": "文件处理", "hint": "需要可读写的 SoduWork 工作目录"},
    "terminal": {"label": "命令与构建", "hint": "需要在执行机上运行命令"},
    "repository": {"label": "代码仓库", "hint": "需要 Git 和可读写工作目录"},
    "browser": {"label": "浏览与检索", "hint": "需要已接通的浏览器自动化能力"},
    "office": {"label": "办公文档", "hint": "需要免费本地文档引擎或显式配置的兼容适配器"},
    "computer": {"label": "操作电脑", "hint": "需要已授权的桌面操作桥接能力"},
}

_ALIASES = {
    "file": "files", "filesystem": "files",
    "shell": "terminal", "command": "terminal", "build": "terminal",
    "git": "repository", "repo": "repository",
    "web": "browser", "browser-use": "browser", "browser_use": "browser",
    "office-cli": "office", "officecli": "office",
    "computer-use": "computer", "computer_use": "computer", "desktop": "computer",
}
_KEY = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
_DECLARED_ENV = ("SODUWORK_RUNNER_CAPABILITIES", "SODUWORK_RUNNER_CAPABILITIES")
_MANAGED = ("browser", "computer")
_DEFAULT_GRANTS = ("browser",)
_SKILL_CAPABILITIES = {
    "browser-use": "browser",
    "computer-use": "computer",
}
_BRIDGE_CACHE: tuple[float, dict[str, tuple[bool, str]]] | None = None
_BRIDGE_CACHE_S = 60.0
_REPORT_CACHE: dict[tuple, tuple[float, dict]] = {}
_REPORT_CACHE_S = 10.0
_REPORT_LOCK = threading.RLock()


def invalidate_bridge_cache() -> None:
    """Invalidate capability caches after component installation or changes."""
    global _BRIDGE_CACHE
    _BRIDGE_CACHE = None
    with _REPORT_LOCK:
        _REPORT_CACHE.clear()


def _values(value) -> list:
    if value is None:
        return []
    if isinstance(value, bytes):
        return [value.decode("utf-8", errors="ignore")]
    if isinstance(value, str):
        return [value]
    try:
        return list(value)
    except TypeError:
        return [value]


def normalize(values: Iterable | None) -> list[str]:
    """Normalize and deduplicate capability IDs, preserving valid unknown IDs for organization
    extensions.
    """
    out: list[str] = []
    for raw in _values(values):
        key = str(raw or "").strip().lower()
        key = _ALIASES.get(key, key)
        if key and _KEY.fullmatch(key) and key not in out:
            out.append(key)
            if len(out) >= 64:
                break
    return out


def label(key: str) -> str:
    key = str(key or "").strip().lower()
    return CATALOG.get(key, {}).get("label") or key


def _declared(values: Iterable | None = None) -> list[str]:
    raw = _values(values)
    for name in _DECLARED_ENV:
        raw.extend(re.split(r"[,;\s]+", str(os.environ.get(name) or "")))
    return normalize(raw)


def _which(names: Iterable[str]) -> str:
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return ""


def _git_candidates(env: dict | None = None) -> list[str]:
    """Check common Git installation paths when a Windows GUI process has stale PATH values."""
    values = os.environ if env is None else env
    pf = values.get("ProgramFiles") or values.get("PROGRAMFILES") or r"C:\Program Files"
    pfx = (values.get("ProgramFiles(x86)") or values.get("PROGRAMFILES(X86)")
           or r"C:\Program Files (x86)")
    local = values.get("LOCALAPPDATA") or ""
    profile = values.get("USERPROFILE") or ""
    explicit = values.get("SODUWORK_GIT") or values.get("SODUWORK_GIT") or ""
    return [
        explicit,
        os.path.join(pf, "Git", "cmd", "git.exe"),
        os.path.join(pf, "Git", "bin", "git.exe"),
        os.path.join(pfx, "Git", "cmd", "git.exe"),
        os.path.join(pfx, "Git", "bin", "git.exe"),
        os.path.join(local, "Programs", "Git", "cmd", "git.exe") if local else "",
        os.path.join(profile, "scoop", "apps", "git", "current", "cmd", "git.exe")
        if profile else "",
    ]


def _git_path() -> str:
    """Locate Git without requiring the desktop app to inherit a freshly updated PATH."""
    found = _which(("git", "git.exe"))
    if found or os.name != "nt":
        return found
    return next((path for path in _git_candidates() if path and os.path.isfile(path)), "")


def _office_candidates(env: dict | None = None) -> list[str]:
    """Only accept a managed or explicitly configured optional CLI adapter.

    A global ``officecli`` command may be the hosted, credit-based product.  SoduWork must
    never silently turn that unrelated installation into an enterprise capability.
    """
    values = os.environ if env is None else env
    return [
        values.get("SODUWORK_MANAGED_OFFICECLI") or "",
        values.get("SODUWORK_OFFICECLI") or values.get("SODUWORK_OFFICECLI") or "",
    ]


def _office_path() -> str:
    return next((path for path in _office_candidates()
                 if path and os.path.isfile(path)), "")


def _office_probe_argv(command: str, env: dict | None = None,
                       windows: bool | None = None) -> list[str]:
    is_windows = os.name == "nt" if windows is None else bool(windows)
    if is_windows and command.lower().endswith((".cmd", ".bat")):
        values = os.environ if env is None else env
        shell = values.get("ComSpec") or values.get("COMSPEC") or "cmd.exe"
        return [shell, "/d", "/s", "/c",
                '"%s" --version' % command.replace('"', '""')]
    return [command, "--version"]


def _office_probe_command(command: str, env: dict | None = None,
                          windows: bool | None = None) -> list[str] | str:
    """Use a raw CreateProcess command line for Windows command shims.

    Passing a quoted ``.cmd`` path in a normal argv list makes Python escape the
    quotes, so cmd.exe treats them as part of the executable name.
    """
    argv = _office_probe_argv(command, env, windows)
    is_windows = os.name == "nt" if windows is None else bool(windows)
    if is_windows and command.lower().endswith((".cmd", ".bat")):
        shell = str(argv[0]).replace('"', '""')
        target = command.replace('"', '""')
        return '"%s" /d /s /c ""%s" --version"' % (shell, target)
    return argv


def _version_argv(argv: list[str] | str) -> tuple[bool, str]:
    """Run a bounded, side-effect-free version probe for a local bridge."""
    if not argv or (isinstance(argv, list) and not argv[0]):
        return False, ""
    try:
        done = subprocess.run(
            argv, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", timeout=2.5,
            check=False, creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
        )
        first = str(done.stdout or "").strip().splitlines()
        return done.returncode == 0, (first[0][:120] if first else "")
    except Exception as exc:  # noqa: BLE001 - a broken bridge is a capability fact
        return False, ("%s: %s" % (type(exc).__name__, str(exc)))[:120]


def _version(command: str) -> tuple[bool, str]:
    return _version_argv([command, "--version"] if command else [])


def _office_version(command: str) -> tuple[bool, str]:
    return _version_argv(_office_probe_command(command) if command else [])


def _office_python_version(env: dict | None = None) -> tuple[bool, str]:
    """Probe the dependency-free-to-SoduWork, open-source Python Office stack."""
    values = os.environ if env is None else env
    explicit = str(values.get("SODUWORK_OFFICE_PYTHON") or "")
    candidates = [explicit, _which(("python3",)), _which(("python",)), _which(("py", "py.exe"))]
    checked: set[str] = set()
    code = ("import importlib.util;mods=('docx','openpyxl','pptx');"
            "missing=[x for x in mods if importlib.util.find_spec(x) is None];"
            "assert not missing,','.join(missing);"
            "print('python-docx + openpyxl + python-pptx')")
    for command in candidates:
        command = str(command or "").strip()
        norm = os.path.normcase(command)
        if not command or norm in checked:
            continue
        checked.add(norm)
        prefix = [command]
        if os.path.basename(command).lower() in {"py", "py.exe"}:
            prefix.append("-3")
        ok, detail = _version_argv(prefix + ["-c", code])
        if ok:
            return True, "免费本地引擎 · " + (detail or "Python Office")
    return False, ""


def _browser_path() -> str:
    env = os.environ
    pf = env.get("ProgramFiles") or env.get("PROGRAMFILES") or r"C:\Program Files"
    pfx = env.get("ProgramFiles(x86)") or env.get("PROGRAMFILES(X86)") or r"C:\Program Files (x86)"
    local = env.get("LOCALAPPDATA") or ""
    candidates = [
        env.get("SODUWORK_BROWSER") or env.get("SODUWORK_BROWSER") or "",
        os.path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(pfx, "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(pfx, "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(local, "Google", "Chrome", "Application", "chrome.exe") if local else "",
        os.path.join(local, "Microsoft", "Edge", "Application", "msedge.exe") if local else "",
        "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    return next((x for x in candidates if x and os.path.isfile(x)), "")


def _skill_file(name: str, relative: str = "SKILL.md") -> str:
    """Locate SoduWork's reviewed bundled bridge, not an arbitrary same-name user skill."""
    try:
        from . import skills
        return os.path.join(skills.bundled_root(), name, *relative.split("/"))
    except Exception:  # noqa: BLE001
        return ""


def _bridge_facts(force: bool = False) -> dict[str, tuple[bool, str]]:
    """Probe expensive bridge facts once per minute so heartbeats stay cheap."""
    global _BRIDGE_CACHE
    now = time.monotonic()
    if not force and _BRIDGE_CACHE and now - _BRIDGE_CACHE[0] < _BRIDGE_CACHE_S:
        return dict(_BRIDGE_CACHE[1])

    browser_skill = _skill_file("browser-use", "scripts/browser.mjs")
    node = _which(("node", "node.exe"))
    browser = _browser_path()
    node_ok, node_version = _version(node)
    hit = re.search(r"v?(\d+)", node_version)
    major = int(hit.group(1)) if hit else 0
    if not os.path.isfile(browser_skill):
        browser_fact = (False, "浏览器能力脚本不完整")
    elif not browser:
        browser_fact = (False, "没有找到 Chrome 或 Edge")
    elif not node_ok or major < 22:
        browser_fact = (False, "需要 Node 22 或更高版本")
    else:
        browser_fact = (True, "%s · Node %s" % (
            os.path.basename(browser), node_version.lstrip("v") or major))

    computer_script = _skill_file("computer-use", "scripts/screen.ps1")
    if os.name != "nt":
        computer_fact = (False, "当前仅支持 Windows 桌面")
    elif not os.path.isfile(computer_script):
        computer_fact = (False, "桌面操作能力脚本不完整")
    else:
        computer_fact = (True, "Windows 桌面控制")

    office_skill = _skill_file("office")
    python_ok, python_version = _office_python_version()
    office = _office_path()
    office_ok, office_version = _office_version(office)
    if not os.path.isfile(office_skill):
        office_fact = (False, "Office 能力说明不完整")
    elif python_ok:
        office_fact = (True, python_version)
    elif not office:
        office_fact = (False, "尚未安装免费办公文档引擎")
    elif not office_ok:
        office_fact = (False, "已找到自选文档适配器，但启动失败" +
                       (("：" + office_version) if office_version else ""))
    else:
        office_fact = (True, "自选适配器 · " + (office_version or os.path.basename(office)))


    facts = {"browser": browser_fact, "computer": computer_fact, "office": office_fact}
    _BRIDGE_CACHE = (now, dict(facts))
    return facts


def runtime_report(work_root: str = "", declared: Iterable | None = None,
                   grants: Iterable | None = None) -> dict:
    """Probe local execution capabilities without file creation, GUI startup, or credential reads.
    Return heartbeat-safe metadata; SODUWORK_RUNNER_CAPABILITIES can declare managed bridges and
    organization extensions.
    """
    explicit = set(_declared(declared))
    granted = set(normalize(_DEFAULT_GRANTS if grants is None else grants))
    root = os.path.abspath(os.path.expanduser(str(work_root or ""))) if work_root else ""
    cache_key = (root, tuple(sorted(explicit)), tuple(sorted(granted)))
    now = time.monotonic()
    with _REPORT_LOCK:
        cached = _REPORT_CACHE.get(cache_key)
        if cached and now - cached[0] < _REPORT_CACHE_S:
            return copy.deepcopy(cached[1])

    root_exists = bool(root and os.path.isdir(root))
    root_ready = bool(root_exists and os.access(root, os.R_OK | os.W_OK))
    root_detail = (root if root_ready else "尚未配置工作目录" if not root
                   else "工作目录不存在" if not root_exists else "工作目录不可读写")
    git = _git_path()

    facts: dict[str, dict] = {
        "terminal": {"installed": True, "authorized": True, "source": "runtime",
                     "detail": "Runner 可以启动受控子进程"},
        "files": {"installed": root_ready, "authorized": True, "source": "work-root",
                  "detail": root_detail},
        "repository": {
            "installed": bool(root_ready and git), "authorized": True, "source": "git",
            "detail": (git if root_ready and git else
                       ("工作目录未就绪" if not root_ready else "没有检测到 Git")),
        },
    }
    for key, (installed, detail) in _bridge_facts().items():
        # Installed usable Office tools provide local document capability.
        # Only managed browser and desktop bridges require explicit grants.
        authorized = key not in _MANAGED or key in granted
        facts[key] = {
            "installed": installed,
            "authorized": authorized,
            "source": "bridge",
            "detail": (detail if (installed and authorized) or not installed
                       else "已检测到，等待本机授权"),
            "configurable": key in _MANAGED,
        }
    for key in explicit:
        # Environment declarations cannot fabricate filesystem, command, or Git availability.
        # Explicit declarations cover managed bridges and organization extensions only.
        if key in ("files", "terminal", "repository"):
            continue
        current = facts.get(key, {})
        facts[key] = {
            **current,
            "installed": True,
            "authorized": True,
            "source": "declared",
            "detail": (current.get("detail") if current.get("installed")
                       else "由执行机管理员显式声明"),
        }

    component_items: dict[str, dict] = {}
    try:
        from . import runtime_components
        component_items = {str(x.get("key") or ""): x
                           for x in runtime_components.status().get("items") or []
                           if isinstance(x, dict) and x.get("key")}
    except Exception:  # noqa: BLE001 - Invalid component metadata must not block Runner heartbeats.
        component_items = {}

    items = []
    for key in list(CATALOG) + [x for x in sorted(facts) if x not in CATALOG]:
        fact = facts[key]
        installed = bool(fact.get("installed"))
        authorized = bool(fact.get("authorized"))
        ready = installed and authorized
        component = component_items.get(key) or {}
        items.append({
            "key": key, "label": label(key), "available": bool(ready),
            "installed": installed, "authorized": authorized,
            "configurable": bool(fact.get("configurable", key in _MANAGED)),
            "source": str(fact.get("source") or "")[:40],
            "detail": str(fact.get("detail") or "")[:300],
            "installable": bool(component.get("installable")),
            "componentKind": str(component.get("kind") or "")[:40],
            "componentVersion": str(component.get("activeVersion") or "")[:64],
            "targetVersion": str(component.get("targetVersion") or "")[:64],
            "componentReason": str(component.get("reason") or "")[:200],
        })
    report = {
        "schemaVersion": SCHEMA_VERSION,
        "reportedAt": int(time.time()),
        "available": [x["key"] for x in items if x["available"]],
        "items": items,
    }
    with _REPORT_LOCK:
        _REPORT_CACHE[cache_key] = (time.monotonic(), copy.deepcopy(report))
    return report


def clean_report(value) -> dict:
    """Normalize untrusted Runner capability reports, including older reports with only available.

    """
    raw = value if isinstance(value, dict) else {}
    available = set(normalize(raw.get("available") or []))
    details: dict[str, dict] = {}
    for item in raw.get("items") or []:
        if not isinstance(item, dict):
            continue
        keys = normalize([item.get("key")])
        if not keys:
            continue
        key = keys[0]
        ready = bool(item.get("available"))
        if ready:
            available.add(key)
        details[key] = {
            "key": key, "label": label(key), "available": ready,
            "installed": bool(item.get("installed", ready)),
            "authorized": bool(item.get("authorized", ready)),
            "configurable": bool(item.get("configurable", key in _MANAGED)),
            "source": str(item.get("source") or "reported")[:40],
            "detail": str(item.get("detail") or "")[:300],
            "installable": bool(item.get("installable")),
            "componentKind": str(item.get("componentKind") or "")[:40],
            "componentVersion": str(item.get("componentVersion") or "")[:64],
            "targetVersion": str(item.get("targetVersion") or "")[:64],
            "componentReason": str(item.get("componentReason") or "")[:200],
        }
    keys = list(CATALOG) + [x for x in sorted(available | set(details)) if x not in CATALOG]
    items = [details.get(key, {
        "key": key, "label": label(key), "available": key in available,
        "installed": key in available, "authorized": key in available,
        "configurable": key in _MANAGED,
        "source": "reported", "detail": "",
        "installable": False, "componentKind": "", "componentVersion": "",
        "targetVersion": "", "componentReason": "",
    }) for key in keys]
    # available is the authoritative quick index; stale or contradictory items must not erase it.
    for item in items:
        if item["key"] in available:
            item["available"] = True
            item["installed"] = True
            item["authorized"] = True
    try:
        reported_at = max(0, int(raw.get("reportedAt") or 0))
    except (TypeError, ValueError, OverflowError):
        reported_at = 0
    return {
        "schemaVersion": SCHEMA_VERSION,
        "reportedAt": reported_at,
        "available": [x["key"] for x in items if x["available"]],
        "items": items,
    }


def required_for(task=None, ctx: dict | None = None) -> list[str]:
    """Merge scenario-snapshot requirements with the current execution node's requirements."""
    ctx = ctx or {}
    routing = {}
    if isinstance(task, dict):
        routing = task.get("workRouting") or task.get("work_routing") or {}
    elif task is not None:
        routing = getattr(task, "work_routing", None) or {}
    raw = _values((routing or {}).get("requiredAgentCapabilities"))
    raw += _values(ctx.get("requiredAgentCapabilities"))
    required_skills = {
        str((skill or {}).get("name") if isinstance(skill, dict) else skill or "").strip()
        for skill in _values(ctx.get("requiredSkills"))
    }
    for skill in _values(ctx.get("skills")):
        name = str((skill or {}).get("name") if isinstance(skill, dict) else skill or "").strip()
        capability = _SKILL_CAPABILITIES.get(name) if name in required_skills else None
        if capability:
            raw.append(capability)
    # Git delivery or a bound remote repository makes repository capability mandatory.
    repo = dict(ctx.get("repo") or {})
    if str(ctx.get("deliveryMode") or "").lower() == "git" or repo.get("gitUrl"):
        raw.append("repository")
    return normalize(raw)


def dispatchable_skills(skills, report, required_names=None) -> tuple[list, list[str]]:
    """Drop optional bridge Skills that this Runner is not authorized to use.

    Selecting a Skill means "make this tool available when possible"; it must not
    silently turn every unrelated task into a hard scheduling requirement.  A Skill
    explicitly listed in ``required_names`` remains in the packet so the normal
    capability preflight can reject the task with a precise explanation.
    """
    required = {
        str((item or {}).get("name") if isinstance(item, dict) else item or "").strip()
        for item in _values(required_names)
    }
    available = set(clean_report(report).get("available") or [])
    kept, skipped = [], []
    for item in _values(skills):
        name = str((item or {}).get("name") if isinstance(item, dict) else item or "").strip()
        capability = _SKILL_CAPABILITIES.get(name)
        if capability and capability not in available and name not in required:
            skipped.append(name)
            continue
        kept.append(item)
    return kept, skipped


def evaluate(report, required: Iterable | None) -> dict:
    cleaned = clean_report(report)
    need = normalize(required)
    have = set(cleaned.get("available") or [])
    missing = [key for key in need if key not in have]
    items = {str(item.get("key") or ""): item for item in cleaned.get("items") or []}
    return {
        "ok": not missing,
        "required": need,
        "available": list(cleaned.get("available") or []),
        "missing": missing,
        "missingLabels": [label(key) for key in missing],
        "missingDetails": [str((items.get(key) or {}).get("detail") or "") for key in missing],
        "report": cleaned,
    }


def error_message(verdict: dict, machine: str = "这台执行机") -> str:
    labels = list((verdict or {}).get("missingLabels") or [])
    if not labels:
        return ""
    details = list((verdict or {}).get("missingDetails") or [])
    missing = []
    for index, name in enumerate(labels):
        detail = str(details[index] if index < len(details) else "").strip()
        missing.append("%s（%s）" % (name, detail) if detail else str(name))
    facts = {str(item.get("key") or ""): item
             for item in ((verdict or {}).get("report") or {}).get("items", [])
             if isinstance(item, dict)}
    grant_keys = [key for key in (verdict or {}).get("missing") or []
                  if facts.get(key, {}).get("installed") is True
                  and facts.get(key, {}).get("authorized") is False]
    if grant_keys:
        grant_labels = "、".join(label(key) for key in grant_keys)
        if len(grant_keys) == len(labels):
            problem = "%s的%s已检测到，但尚未获得本机授权" % (
                machine or "这台执行机", grant_labels)
        else:
            problem = "%s尚未满足%s" % (machine or "这台执行机", "、".join(missing))
        return ("执行前能力预检未通过：%s。请在目标电脑的 SoduWork → Agent 管理 → Runner "
                "中点击「管理本机能力」，授权%s，然后重新探测并重试；也可改选满足要求的执行机。"
                "企业插件审核不会自动授予本机权限。" % (problem, grant_labels))
    return ("执行前能力预检未通过：%s缺少%s。请在 Agent 管理 → Runner 中查看探测详情，"
            "或改选满足要求的执行机。" % (machine or "这台执行机", "、".join(missing)))

__all__ = [
    "CATALOG", "SCHEMA_VERSION", "clean_report", "dispatchable_skills", "error_message", "evaluate", "label",
    "invalidate_bridge_cache", "normalize", "required_for", "runtime_report",
]
