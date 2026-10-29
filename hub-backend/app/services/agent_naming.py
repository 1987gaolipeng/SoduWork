"""Deterministic agent display names and Runner identity."""
from __future__ import annotations

import re

_HOSTED = "托管智能体"

#: Fallback local-machine key before the hostname is known.
LOCAL = "local"

#: Opaque hostnames include hexadecimal container IDs.
#: Include the OS label when useful for disambiguation.
_OPAQUE = re.compile(r"^[0-9a-f]{10,}$", re.I)

_OS_TAGS = (
    ("windows", "Windows"), ("darwin", "macOS"), ("mac", "macOS"),
    ("linux", "Linux"), ("anolis", "Linux"), ("centos", "Linux"),
    ("ubuntu", "Linux"), ("debian", "Linux"),
)


def os_tag(os_name: str) -> str:
    """Reduce platform strings to a short OS label; return empty for unknown platforms."""
    text = str(os_name or "").strip().lower()
    for needle, tag in _OS_TAGS:
        if needle in text:
            return tag
    return ""


def machine_key(*, host: str = "", runner_id: str = "") -> str:
    """Return a stable machine identity independent of execution transport. Backend-local processes
    and a desktop Runner on the same host represent the same underlying runtime. Including the
    provider or a missing historical runtime key would create duplicate workstation entries."""
    text = str(host or "").strip().lower()
    if text:
        return "host:" + text
    rid = str(runner_id or "").strip().lower()
    if rid:
        return "rid:" + rid
    return LOCAL


#: Legacy local providers without a hostname run on the backend host.
#: Group those providers under the backend host rather than an unknown machine.
_LOCAL_PROVIDERS = ("", "local", "runner")


def machine_key_for(*, provider: str = "", host: str = "", runner_id: str = "",
                    local_host: str = "") -> str:
    """Behavior and constraints for this operation."""
    mk = machine_key(host=host, runner_id=runner_id)
    if mk != LOCAL:
        return mk
    kind = str(provider or "").strip().lower()
    if kind not in _LOCAL_PROVIDERS:
        return "hosted:" + kind
    text = str(local_host or "").strip()
    return machine_key(host=text) if text else LOCAL


def auto_machine_label(*, host: str = "", runner_id: str = "", os_name: str = "",
                       fallback: str = "") -> str:
    """Default machine label: hostname, short Runner ID, then fallback. Owner names are unsuitable
    when an owner has several machines.
    """
    text = str(host or "").strip()
    if text:
        # Add an OS label to opaque hostnames.
        return "%s(%s)" % (text, os_tag(os_name)) if (_OPAQUE.match(text) and os_tag(os_name)) else text
    rid = str(runner_id or "").strip()
    if rid:
        return rid[:12]
    return str(fallback or "").strip() or "未知执行机"


def unique_machine_labels(machines: list[dict]) -> dict[str, str]:
    """Build unique labels, preserving custom aliases. Use the owner's name for one machine and add
    host information for multiple machines.
    """
    out: dict[str, str] = {}
    auto: dict[str, dict] = {}
    for item in machines:
        key = str(item.get("key") or "")
        if not key or key in out or key in auto:
            continue
        alias = str(item.get("alias") or "").strip()
        if alias:
            out[key] = alias
        else:
            auto[key] = item

    person_counts: dict[str, int] = {}
    for item in auto.values():
        person = str(item.get("person") or "").strip()
        if person:
            key = person.casefold()
            person_counts[key] = person_counts.get(key, 0) + 1

    def generated(item: dict) -> str:
        machine = auto_machine_label(
            host=item.get("host", ""), runner_id=item.get("runnerId", ""),
            os_name=item.get("osName", ""), fallback=item.get("fallback", ""))
        person = str(item.get("person") or "").strip()
        if not person:
            return machine
        if person_counts.get(person.casefold(), 0) == 1:
            return "%s的电脑" % person
        return "%s · %s" % (person, machine)

    seen: dict[str, int] = {}
    for item in auto.values():
        value = generated(item)
        seen[value] = seen.get(value, 0) + 1
    for key, item in auto.items():
        value = generated(item)
        if seen.get(value, 0) > 1 or value in out.values():
            tag = os_tag(item.get("osName", ""))
            if tag and "(%s)" % tag not in value:
                value = "%s(%s)" % (value, tag)
        if value in out.values():
            rid = str(item.get("runnerId") or key).strip()
            value = "%s #%s" % (value, rid[-6:] or "??")
        out[key] = value
    return out

def display_name(cli_name: str, machine: str = "", **legacy) -> str:
    """Label an agent seat with its machine and CLI runtime."""
    cli = str(cli_name or "").strip() or "AI"
    label = str(machine or "").strip()
    if not label:
        label = machine_label(alias=legacy.get("alias", ""), person=legacy.get("person", ""),
                              host=legacy.get("host", ""), runner_id=legacy.get("runner_id", ""),
                              os_name=legacy.get("os_name", ""),
                              fallback=legacy.get("fallback", ""))
    return "%s · %s" % (label, cli)

def machine_label(*, alias: str = "", person: str = "", host: str = "",
                  runner_id: str = "", os_name: str = "", fallback: str = "") -> str:
    """Choose a single-machine label: alias, owner, host, ID, then fallback."""
    text = str(alias or "").strip()
    if text:
        return text
    owner = str(person or "").strip()
    if owner:
        return "%s的电脑" % owner
    return auto_machine_label(host=host, runner_id=runner_id, os_name=os_name, fallback=fallback)

def hosted_name() -> str:
    """Managed executors are distinct from local machines."""
    return _HOSTED


from ..agent_catalog import AGENTS as _AGENT_CATALOG

_CLI_ALIAS = {"claude-code": "claude", "claudecode": "claude"}  # Historical names, not selectable Agents.
_CLI_ALIAS.update({label.lower().replace(" ", "").replace("_", ""): key
                   for key, row in _AGENT_CATALOG.items()
                   for label in (key, row["displayName"])})
#: Infer a missing assigneeCli from the display-name suffix.
#: Avoid creating a duplicate seat with an empty CLI key.
_CLI_BY_LABEL = {key: key for key in (*_AGENT_CATALOG, *_CLI_ALIAS.values())}


def cli_key(value: str) -> str:
    """Normalize runtime display names such as OpenCode and Claude Code to shared historical and
    live keys.
    """
    text = str(value or "").strip().lower().replace(" ", "").replace("_", "")
    return _CLI_ALIAS.get(text, text)


def cli_from_name(name: str) -> str:
    """Infer the runtime from the suffix of a workstation label, such as DESKTOP-FIXTURE followed
    by Pi. Historical dispatch events may omit assigneeCli; fill it from the label to avoid a
    duplicate entry with an empty runtime identity."""
    tail = str(name or "").split(" · ")[-1]
    return _CLI_BY_LABEL.get(cli_key(tail), "")


def desk_key(*, machine: str = "", cli: str = "", name: str = "",
             runner_id: str = "", host: str = "", provider: str = "") -> str:
    """Group by machine and runtime, preserving history across display-name changes; provider is
    only a compatibility fallback.
    """
    mk = str(machine or "").strip() or machine_key(host=host, runner_id=runner_id)
    kind = cli_key(cli) or cli_from_name(name)
    if mk == LOCAL and not kind:
        # Without machine or CLI identity, retain the historical name as the grouping key.
        # Do not merge unrelated historical seats.
        return "name:" + (str(name or "").strip() or "agent")
    return mk + "|" + kind
