"""Project the model catalog observed by the executing account Codex CLI."""
from pathlib import Path
import re
import threading
from typing import NamedTuple

from . import agent_execution_options as options, codex_account_home, codex_model_catalog


class _Upgrade(NamedTuple):
    root: str
    executable: str
    version: str
    job_id: str


_upgrade_lock = threading.Lock()
_last_upgrade: _Upgrade | None = None


def _upgrade_status(root, executable, reported, requested):
    from . import agent_setup
    global _last_upgrade
    match = re.fullmatch(r"(?:codex-cli )?(\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)", reported)
    if not match:
        return {}
    version = match[1]
    with _upgrade_lock:
        if (_last_upgrade and _last_upgrade.root == root and _last_upgrade.executable == executable
                and _last_upgrade.version == version):
            job = agent_setup.job(_last_upgrade.job_id)
            status = "updating" if job and job["state"] == "running" else "update-failed"
        elif requested:
            _last_upgrade = _Upgrade(root, executable, version, agent_setup.start_install("codex", "update"))
            status = "updating"
        else:
            status = "update-required"
    return {"cliVersion": version, "upgradeState": status}


def list_models(data_root: str, ref: str = "", *, ensure_compatible: bool = False) -> dict:
    from . import agent_setup
    result = {"ok": True, "adapterId": "codex", "source": "", "catalogAvailable": False, "retryable": True, "models": []}
    if not isinstance(ref, str) or len(ref) > 160:
        return result
    try:
        root = str(Path(data_root).resolve())
        home = codex_account_home.model_catalog_home(root, ref)
        if not home:
            return result
        # npm can temporarily replace the executable during an update.
        with _upgrade_lock:
            if _last_upgrade and _last_upgrade.root == root:
                job = agent_setup.job(_last_upgrade.job_id)
                if job and job["state"] == "running":
                    return {**result, "cliVersion": _last_upgrade.version, "upgradeState": "updating"}
        executable = agent_setup._bin_of("codex")
        try:
            rows, source = codex_model_catalog.discover(executable, home, check_default=True)
        except codex_model_catalog.UpgradeRequired as exc:
            if (codex_account_home.model_catalog_home(root, ref) == home
                    and agent_setup._bin_of("codex") == executable):
                result.update(_upgrade_status(root, executable, str(exc), ensure_compatible))
            return result
        if (codex_account_home.model_catalog_home(root, ref) != home
                or agent_setup._bin_of("codex") != executable):
            return result
    except (OSError, ValueError, RuntimeError):
        return result
    if rows is None:
        if source == "codex-native-default":
            result["nativeDefaultAvailable"] = True
        return result
    result.update(source=source, catalogAvailable=True, retryable=source != "codex-native")
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or row.get("hidden") or row.get("visibility") not in (None, "", "list"):
            continue
        model = row.get("slug") or row.get("id") or row.get("name")
        if (not isinstance(model, str) or not model or model != model.strip() or model in seen
                or not options.validate_native_model(options.CODEX_KIND, model)["ok"]):
            continue
        seen.add(model)
        efforts = row.get("supported_reasoning_levels", row.get("supportedReasoningLevels"))
        levels = [(value.get("effort") or value.get("name")) if isinstance(value, dict) else value
                  for value in efforts] if isinstance(efforts, list) else []
        default = row.get("default_reasoning_level", row.get("defaultReasoningLevel"))
        label = row.get("display_name") or row.get("displayName")
        result["models"].append({"id": model, "label": label[:120] if isinstance(label, str) and label.strip() else model,
                                 "reasoningLevels": list(dict.fromkeys(v for v in levels if v in options.CODEX_REASONING_EFFORTS)),
                                 "defaultReasoning": default if default in options.CODEX_REASONING_EFFORTS else ""})
    return result
