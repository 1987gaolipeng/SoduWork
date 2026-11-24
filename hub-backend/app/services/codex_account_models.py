"""Project the model catalog observed by the executing account Codex CLI."""
from pathlib import Path

from . import agent_execution_options as options, codex_account_home, codex_model_catalog


def list_models(data_root: str, ref: str = "") -> dict:
    from . import agent_setup
    result = {"ok": True, "adapterId": "codex", "source": "", "catalogAvailable": False, "retryable": True, "models": []}
    if not isinstance(ref, str) or len(ref) > 160:
        return result
    try:
        root = str(Path(data_root).resolve())
        home = codex_account_home.model_catalog_home(root, ref)
        if not home:
            return result
        executable = agent_setup._bin_of("codex")
        rows, source = codex_model_catalog.discover(executable, home)
        if (rows is None or codex_account_home.model_catalog_home(root, ref) != home
                or agent_setup._bin_of("codex") != executable):
            return result
    except (OSError, ValueError, RuntimeError):
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
