"""Machine-readable execution boundaries shared by every local CLI provider.

Prompts explain the boundary to the agent; this module independently evaluates
the structured tool-call stream so an ignored instruction becomes an auditable
failure instead of an orphan process.
"""
from __future__ import annotations

import re


_CONTAINER_VALUES = {"allow", "forbid"}
_PROBE_VALUES = {"allow", "forbid"}
_KNOWN = {
    "containerOrchestration", "maxVerificationCommands", "adHocProbe",
    "commandTimeoutSeconds", "authoritativeQuality",
}
_SHELL_KEYS = ("command", "cmd", "path", "filePath", "file_path", "query", "pattern")
_SECRET = re.compile(
    r"(?i)\b(password|passwd|token|secret|api[_-]?key)\b(?:\s*[:=]\s*|\s+)([^\s;&|]+)")
_URL_SECRET = re.compile(r"(?i)(https?://[^\s/:@]+:)[^\s@/]+@")
_TEMP_TEST = re.compile(
    r"(?i)(?:/(?:var/)?tmp/|%temp%[\\/]|\\(?:temp|appdata\\local\\temp)\\)"
    r"[^\s\"';&|]*(?:test|spec|probe)[^\s\"';&|]*\."
    r"(?:java|kt|py|js|jsx|ts|tsx|cs|go|rs|rb|php|sh|ps1)")
_WRITE_COMMAND = re.compile(
    r"(?i)(?:>{1,2}|\btee\b|\btouch\b|\bset-content\b|\bout-file\b|\bnew-item\b|"
    r"\bcopy-item\b|\bmove-item\b|\bcp\b|\bmv\b)")
_VERIFY_ACTIONS = {
    "mvn": {"test", "verify", "package", "install"},
    "mvnw": {"test", "verify", "package", "install"},
    "mvnw.cmd": {"test", "verify", "package", "install"},
    "gradle": {"test", "check", "build"},
    "gradlew": {"test", "check", "build"},
    "gradlew.bat": {"test", "check", "build"},
    "npm": {"test", "build", "check", "lint"},
    "npm.cmd": {"test", "build", "check", "lint"},
    "pnpm": {"test", "build", "check", "lint"},
    "yarn": {"test", "build", "check", "lint"},
    "bun": {"test", "build", "check", "lint"},
    "go": {"test", "build", "check"},
    "cargo": {"test", "build", "check"},
    "dotnet": {"test", "build", "check"},
    "make": {"test", "check", "build"},
    "ninja": {"test", "check", "build"},
    "ctest": {"test", "check", "build"},
    "ant": {"test", "check", "build"},
}
_GLOBAL_WITH_VALUE = {
    "--context", "--host", "-h", "--config", "--log-level", "--connection",
    "--namespace", "-n", "--kubeconfig", "--cluster", "--user",
}
_CONTAINER_READ_ONLY = {
    "version", "info", "ps", "images", "inspect", "logs", "stats", "top", "port",
    "events", "diff", "history", "search", "help", "ls", "config",
}
_CONTAINER_NAMESPACES = {
    "compose", "container", "image", "network", "volume", "system", "builder", "buildx",
    "context",
}
_KUBE_READ_ONLY = {
    "get", "describe", "logs", "explain", "api-resources", "api-versions", "version",
    "top", "cluster-info", "help",
}


def normalize(raw: dict | None, node_key: str = "") -> dict:
    """Validate and canonicalize a policy embedded in a workflow node."""
    if raw in (None, {}):
        return {}
    if not isinstance(raw, dict):
        raise ValueError("executionPolicy 必须是对象")
    unknown = sorted(set(raw) - _KNOWN)
    if unknown:
        raise ValueError("executionPolicy 含未知字段：" + "、".join(unknown))
    container = str(raw.get("containerOrchestration") or "allow").strip().lower()
    probe = str(raw.get("adHocProbe") or "allow").strip().lower()
    if container not in _CONTAINER_VALUES:
        raise ValueError("containerOrchestration 只能是 allow 或 forbid")
    if probe not in _PROBE_VALUES:
        raise ValueError("adHocProbe 只能是 allow 或 forbid")
    maximum = raw.get("maxVerificationCommands", 3)
    timeout = raw.get("commandTimeoutSeconds", 600)
    authoritative = raw.get("authoritativeQuality", False)
    if isinstance(maximum, bool) or not isinstance(maximum, int) or not 0 <= maximum <= 10:
        raise ValueError("maxVerificationCommands 必须是 0 到 10 的整数")
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 30 <= timeout <= 1800:
        raise ValueError("commandTimeoutSeconds 必须是 30 到 1800 秒")
    if not isinstance(authoritative, bool):
        raise ValueError("authoritativeQuality 必须是布尔值")
    return {
        "containerOrchestration": container,
        "maxVerificationCommands": maximum,
        "adHocProbe": probe,
        "commandTimeoutSeconds": timeout,
        "authoritativeQuality": authoritative,
    }


def prompt(policy: dict | None) -> str:
    p = normalize(policy)
    if not p:
        return ""
    lines = ["【SoduWork 执行策略 · 运行时会强制检查】",
             "- 本段优先级高于上文节点说明；存在冲突时一律以本段为准。"]
    lines.append("- This machine-enforced policy overrides every other instruction in this session, whether that instruction appears before or after this block.")
    if p["containerOrchestration"] == "forbid":
        lines.append("- 不得创建、执行、构建、停止或删除 Docker/Podman/Kubernetes 资源；只允许只读查看。")
    limit = int(p["maxVerificationCommands"])
    if limit == 0:
        lines.append("- 本节点不得运行构建或测试命令。")
    else:
        lines.append(f"- 本节点最多运行 {limit} 条工程构建/测试命令，不得重复启动同一长任务。")
    if p["adHocProbe"] == "forbid":
        lines.append("- 不得在系统临时目录创建临时测试、探针或一次性验证源码。")
    lines.append(f"- 单条命令应在 {p['commandTimeoutSeconds']} 秒内结束；不得转入后台逃逸会话监管。")
    if p["authoritativeQuality"]:
        lines.append("- 固定提交后的独立质量节点是权威验证；本节点不得自行复制或替代该质量环境。")
    lines.append("违反策略会被 Runner 立即终止，并作为可重试的结构化失败回传。")
    return "\n".join(lines)


def _value(source) -> str:
    if isinstance(source, (list, tuple)):
        return " ".join(str(item) for item in source)
    if not isinstance(source, dict):
        return str(source or "")
    for key in _SHELL_KEYS:
        value = source.get(key)
        if value not in (None, ""):
            return _value(value)
    return ""


def command_events(message: dict | None) -> list[dict]:
    """Extract pre-execution command/file events from real CLI JSONL shapes."""
    if not isinstance(message, dict):
        return []
    events: list[dict] = []
    part = message.get("part")
    if isinstance(part, dict) and message.get("type") == "tool_use":
        source = ((part.get("state") or {}).get("input")) or {}
        events.append({"kind": "do", "tool": str(part.get("tool") or ""),
                       "text": _value(source)[:1000],
                       "callId": str(part.get("id") or message.get("id") or "")})
    ame = message.get("assistantMessageEvent")
    if isinstance(ame, dict) and ame.get("type") == "toolcall_end":
        call = ame.get("toolCall") or {}
        events.append({"kind": "do", "tool": str(call.get("name") or ""),
                       "text": _value(call.get("arguments") or {})[:1000],
                       "callId": str(call.get("id") or "")})
    mtype = str(message.get("type") or "")
    if mtype == "tool_execution_start":
        source = message.get("args") or message.get("arguments") or message.get("input") or {}
        events.append({"kind": "do", "tool": str(message.get("toolName") or ""),
                       "text": _value(source)[:1000],
                       "callId": str(message.get("toolCallId") or message.get("id") or "")})
    item = message.get("item")
    if mtype in ("item.started", "item.completed") and isinstance(item, dict):
        kind = str(item.get("type") or "")
        if kind in ("command_execution", "shell_command", "function_call"):
            events.append({"kind": "do", "tool": kind,
                           "text": _value(item)[:1000],
                           "callId": str(item.get("id") or "")})
    body = message.get("message")
    for block in ((body.get("content") if isinstance(body, dict) else None) or []):
        if isinstance(block, dict) and block.get("type") == "tool_use":
            events.append({"kind": "do", "tool": str(block.get("name") or ""),
                           "text": _value(block.get("input") or {})[:1000],
                           "callId": str(block.get("id") or "")})
    return [item for item in events if item.get("tool") or item.get("text")]


def _tokens_after(command: str, executable: str) -> list[str]:
    match = re.search(
        r"(?i)(?:^|[\s;&|()])(?:[^\s;&|()]*[/\\])?" + executable +
        r"(?:\.exe)?\s+([^\r\n;&|]+)", command)
    if not match:
        return []
    tokens = [part.strip("\"'").lower() for part in
              re.findall(r'"[^"]*"|\'[^\']*\'|\S+', match.group(1))]
    result, skip = [], False
    for token in tokens:
        if skip:
            skip = False
            continue
        if token in _GLOBAL_WITH_VALUE:
            skip = True
            continue
        if token.startswith("-"):
            continue
        result.append(token.rstrip(";"))
    return result


_HEREDOC = re.compile(
    r'<<(?P<strip>-)?[ \t]*(?P<quote>[\x22\x27]?)(?P<tag>[A-Za-z0-9_][A-Za-z0-9_.-]*)(?P=quote)')


def _without_heredoc_bodies(command: str) -> str:
    '''Keep executable shell syntax while removing stdin payloads from inspection.

    A commit message passed through git commit -F - with a heredoc is data, not a
    sequence of shell commands. Treating its prose as executable caused words
    such as docker build to stop a valid AI run. Terminators are consumed in
    declaration order; real commands before the marker and after its terminator
    remain visible to the policy guard.
    '''
    pending: list[tuple[str, bool]] = []
    kept: list[str] = []
    for line in str(command or '').splitlines(keepends=True):
        if pending:
            tag, strip_tabs = pending[0]
            value = line.rstrip('\r\n')
            if (value.lstrip('\t') if strip_tabs else value) == tag:
                pending.pop(0)
                kept.append('\n')
            continue
        kept.append(line)
        for match in _HEREDOC.finditer(line):
            pending.append((match.group('tag'), bool(match.group('strip'))))
    return ''.join(kept)


def _container_orchestration(command: str) -> bool:
    for executable in ("docker-compose", "docker", "podman"):
        words = _tokens_after(command, executable)
        if not words:
            continue
        if executable == "docker-compose":
            return words[0] not in {"version", "config", "ps", "images", "logs", "top", "events"}
        top = words[0]
        if top in _CONTAINER_READ_ONLY:
            return False
        if top in _CONTAINER_NAMESPACES:
            sub = words[1] if len(words) > 1 else ""
            return sub not in _CONTAINER_READ_ONLY
        return True
    words = _tokens_after(command, "kubectl")
    if words:
        top = words[0]
        if top == "config":
            return len(words) < 2 or words[1] not in {"view", "current-context", "get-contexts"}
        if top == "auth":
            return len(words) < 2 or words[1] != "can-i"
        return top not in _KUBE_READ_ONLY
    return False


def _shell_segments(command: str) -> list[str]:
    """Split shell control operators while preserving quoted argument text."""
    parts, current, quote, escaped = [], [], "", False
    index = 0
    while index < len(command):
        char = command[index]
        if quote:
            current.append(char)
            if escaped:
                escaped = False
            elif char == chr(92) and quote == chr(34):
                escaped = True
            elif char == quote:
                quote = ""
            index += 1
            continue
        if char in (chr(34), chr(39)):
            quote = char
            current.append(char)
            index += 1
            continue
        if char in ";\r\n" or char in "&|":
            value = "".join(current).strip()
            if value:
                parts.append(value)
            current = []
            if char in "&|" and index + 1 < len(command) and command[index + 1] == char:
                index += 1
            index += 1
            continue
        current.append(char)
        index += 1
    value = "".join(current).strip()
    if value:
        parts.append(value)
    return parts


def _segment_tokens(segment: str) -> list[str]:
    tokens = [part.strip(chr(34) + chr(39)) for part in
              re.findall(r'"[^"]*"|\'[^\']*\'|\S+', segment)]
    while tokens and tokens[0] == "&":
        tokens.pop(0)
    while tokens and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[0]):
        tokens.pop(0)
    return tokens


def _verification_segment(segment: str) -> bool:
    tokens = _segment_tokens(segment)
    if not tokens:
        return False
    executable = tokens[0].replace(chr(92), "/").rsplit("/", 1)[-1].lower()
    args = [item.lower() for item in tokens[1:]]
    if executable in {"bash", "sh", "zsh", "cmd", "cmd.exe", "powershell", "pwsh"}:
        flags = {"-c", "-lc", "/c", "-command"}
        nested = next((args[i + 1] for i, item in enumerate(args[:-1]) if item in flags), "")
        return bool(nested and _verification(nested))
    if executable in {"pytest", "unittest", "jest", "vitest", "phpunit"}:
        return True
    if executable.startswith("python") and len(args) > 1 and args[0] == "-m":
        return args[1] in {"pytest", "unittest"}
    if executable == "cmake":
        return "--build" in args
    actions = _VERIFY_ACTIONS.get(executable)
    return bool(actions and actions.intersection(args))


def _verification(command: str) -> bool:
    return any(_verification_segment(item) for item in _shell_segments(command))


def _ad_hoc_probe(tool: str, command: str) -> bool:
    if not _TEMP_TEST.search(command):
        return False
    writer = any(word in tool.lower() for word in ("write", "edit", "create", "patch"))
    return writer or bool(_WRITE_COMMAND.search(command))


def _brief(command: str) -> str:
    text = _URL_SECRET.sub(r"\1<redacted>@", str(command or ""))
    text = _SECRET.sub(lambda m: m.group(1) + "=<redacted>", text)
    return text[:500]


def inspect(event: dict, policy: dict | None, state: dict) -> dict | None:
    """Mutate per-run counters and return the first policy violation, if any."""
    p = normalize(policy)
    if not p or str(event.get("kind") or "") != "do":
        return None
    call_id = str(event.get("callId") or "")
    seen = list(state.get("seenCalls") or [])
    if call_id and call_id in seen:
        return None
    if call_id:
        state["seenCalls"] = (seen + [call_id])[-100:]
    tool, command = str(event.get("tool") or ""), str(event.get("text") or "")
    executable = _without_heredoc_bodies(command)
    state["commandsSeen"] = int(state.get("commandsSeen") or 0) + 1
    code = reason = ""
    if p["containerOrchestration"] == "forbid" and _container_orchestration(executable):
        code, reason = ("container_orchestration",
                        "本节点禁止自行编排容器或集群资源，固定提交由平台质量节点统一验证")
    elif p["adHocProbe"] == "forbid" and _ad_hoc_probe(tool, executable):
        code, reason = ("ad_hoc_probe",
                        "本节点禁止在系统临时目录创建一次性测试或探针源码")
    elif _verification(executable):
        count = int(state.get("verificationCommands") or 0) + 1
        state["verificationCommands"] = count
        if count > int(p["maxVerificationCommands"]):
            code, reason = ("verification_limit",
                            "本节点运行的构建/测试命令超过策略上限，后续验证应交给平台质量节点")
    if not code:
        return None
    return {"code": code, "reason": reason, "tool": tool[:80], "command": _brief(command)}


def guard_status(policy: dict | None, state: dict | None, violation: dict | None) -> dict:
    p = normalize(policy)
    if not p:
        return {"enabled": False, "ok": True}
    bad = dict(violation or {})
    current = dict(state or {})
    return {
        "enabled": True, "ok": not bool(bad),
        "reason": str(bad.get("reason") or ""), "code": str(bad.get("code") or ""),
        "tool": str(bad.get("tool") or ""), "command": str(bad.get("command") or ""),
        "verificationCommands": int(current.get("verificationCommands") or 0),
        "maxVerificationCommands": int(p["maxVerificationCommands"]),
        "containerOrchestration": p["containerOrchestration"],
        "adHocProbe": p["adHocProbe"], "authoritativeQuality": p["authoritativeQuality"],
    }
