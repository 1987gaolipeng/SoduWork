"""Project the model catalog observed by the executing account Codex CLI."""
import json
import os
from pathlib import Path
import stat

from . import agent_execution_options as options, codex_account_home
from .native_history_archive import stamp

_MAX_CACHE_BYTES = 16 * 1024 * 1024


def _cache(home: str) -> dict:
    target = Path(home) / "models_cache.json"
    if target.resolve(strict=True) != target:
        raise ValueError("Unexpected Codex catalog location")
    info = target.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > _MAX_CACHE_BYTES:
        raise ValueError("Unusable Codex catalog")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(target, flags), "rb") as stream:
        if stamp(os.fstat(stream.fileno())) != stamp(info):
            raise ValueError("Codex catalog replaced")
        content = stream.read(info.st_size + 1)
        if len(content) != info.st_size or target.resolve(strict=True) != target or stamp(target.lstat()) != stamp(info):
            raise ValueError("Codex catalog changed")
    value = json.loads(content)
    return value if isinstance(value, dict) else {}


def list_models(data_root: str, ref: str = "") -> dict:
    from . import agent_setup
    result = {"ok": True, "adapterId": "codex", "source": "codex-account-cache", "catalogAvailable": False, "models": []}
    if not isinstance(ref, str) or len(ref) > 160:
        return result
    try:
        root = str(Path(data_root).resolve())
        home = codex_account_home.model_catalog_home(root, ref)
        if not home:
            return result
        cached = _cache(home)
        version = cached.get("client_version") or cached.get("clientVersion")
        if not isinstance(version, str) or not version:
            return result
        reported = agent_setup._selected_cli_version("codex")
        if version != reported.removeprefix("codex-cli ") or codex_account_home.model_catalog_home(root, ref) != home:
            return result
        if not isinstance(cached.get("models"), list):
            return result
    except (OSError, ValueError, RuntimeError):
        return result
    result["catalogAvailable"] = True
    seen = set()
    for row in cached["models"]:
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
