"""Resolve direct-task models after the actual Agent seat has been selected."""
from __future__ import annotations

from . import agent_execution_options, ai_exec, ai_exec_route, model_catalog


async def prepare(session, client, ctx: dict, assignee: dict,
                  model: str = "", reasoning_effort: str = "",
                  credential_client=None) -> tuple[dict, dict]:
    cli = ai_exec_route.cli_of(str((assignee or {}).get("id") or ""))
    cli = cli or str((assignee or {}).get("cli") or "").strip().lower()
    if not cli:
        return ctx, {}  # Hosted providers own their execution configuration.
    kind = "local:" + cli
    requested = str(model or "").strip()
    native = agent_execution_options.runtime_options(kind, requested, reasoning_effort)
    if kind in agent_execution_options.GATEWAY_MODEL_KINDS:
        # A conversation may be reopened from another device.  The durable
        # handoff owns the original account/device credential scope; resolve
        # it afresh for this dispatch instead of relying on the current
        # device's in-memory or already-scrubbed configuration.
        credential_owner = credential_client or client
        wanted = requested or model_catalog.agent_model(credential_owner, cli)
        # Explicit and saved Agent choices must not silently become another model
        # when their provider/key is removed. resolve() already enforces that rule.
        llm = await model_catalog.resolve(session, credential_owner, wanted)
        if not llm:
            if wanted:
                raise ValueError("模型「%s」当前不可用，请重新选择可用模型" % wanted)
            # An empty resolution must not preserve disabled legacy credentials.
            raise ValueError("当前没有可用的执行模型，请检查模型服务、密钥和启用状态")
        return ai_exec.with_llm(ctx, llm), native

    # Native-account Agents must not inherit or report the shared model service model.
    out = dict(ctx or {})
    for key in ("cfg", "localCfg"):
        if isinstance(out.get(key), dict):
            config = dict(out[key])
            config.pop("llm", None)
            out[key] = config
    return out, native
