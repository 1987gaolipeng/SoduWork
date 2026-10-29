"""Read-only PPM integration over an explicitly configured HTTP MCP service.

Configuration accepts a managed MCP reference or mcpUrl/mcpKey/keycloak.
Only READ_ALLOWED tools can be called; no write tools are permitted.
"""
from __future__ import annotations

import logging
import time

from ..services import mcp_http
from .testplat import TestPlatConnector, _items_of

log = logging.getLogger("uvicorn.error")

# Compatibility export: Keycloak transport is shared through services/mcp_http.
keycloak_token = mcp_http.keycloak_token

# Allow only the listed read tools for PPM access.
# Exclude issue mutations, task transitions, and worklog decision/fill tools.
# mcp_call rejects unlisted tools even if a caller attempts to invoke them.
READ_ALLOWED = frozenset({"bug_list", "bug_detail", "product_list", "todo_list"})


def _spec(config: dict) -> dict:
    """Resolve MCP configuration, preferring poller-injected config['mcp'] over legacy
    integration-local settings.
    """
    ref = config.get("mcp")
    if isinstance(ref, dict) and ref.get("url"):
        return ref
    key = str(config.get("mcpKey") or "").strip()
    if not key:
        raise ValueError("PPM集成还没配 X-MCP-Key(集成配置里补 mcpKey,"
                         "或在 MCP 管理里配好后用 mcpRef 引用)")
    url = str(config.get("mcpUrl") or "").strip()
    if not url:
        raise ValueError("PPM 集成还没配 mcpUrl，或在 MCP 管理里配置后用 mcpRef 引用")
    return {"url": url,
            "headers": {"X-MCP-Key": key},
            "keycloak": dict(config.get("keycloak") or {})}


def mcp_call(config: dict, tool: str, arguments: dict | None = None):
    """Make one read-only MCP tools/call request with a static X-MCP-Key and dynamic Bearer token.
    READ_ALLOWED is enforced before sending: write tools raise ValueError without making a
    request. This is the PPM adapter's outbound tool boundary."""
    if tool not in READ_ALLOWED:
        raise ValueError(
            "SoduWork 对PPM只读,不允许回写工具「%s」(只放行:%s)"
            % (tool, "、".join(sorted(READ_ALLOWED))))
    return mcp_http.call(_spec(config), tool, arguments)


def bug_detail(config: dict, bug: str) -> dict | None:
    """Read issue details using the bug identifier parameter, not bugId."""
    return mcp_call(config, "bug_detail", {"bug": str(bug)})


class PpmConnector:
    type = "ppm"
    scheduled = True          # The poller interval is controlled by POLL_INTERVAL_SECONDS.

    _shape = TestPlatConnector()      # Reuse shared field aliases and status normalization.

    def to_envelope(self, item: dict, field_map: dict | None = None) -> dict | None:
        env = self._shape.to_envelope(item, field_map)
        if env is not None:
            env["source_label"] = "PPM Beta 单 #" + env["external_id"]
        return env

    def pull(self, config: dict, cursor: dict) -> tuple[list[dict], dict]:
        """Poll bug_list(productId) into Envelopes. Idempotent upserts handle a full result set;
        the cursor currently records observations rather than enabling unverified incremental
        parameters."""
        cfg = dict(config or {})
        product = cfg.get("productId")
        if product in (None, ""):
            raise ValueError("PPM集成还没配 productId")
        data = mcp_call(cfg, str(cfg.get("listTool") or "bug_list"),
                        {"productId": int(product)})
        fm = cfg.get("fieldMap") if isinstance(cfg.get("fieldMap"), dict) else {}
        envelopes = []
        for it in _items_of(data):
            env = self.to_envelope(it, fm)
            if env:
                envelopes.append(env)
        return envelopes, {"lastCount": len(envelopes), "at": int(time.time())}
