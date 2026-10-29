"""Public module behavior and service contracts."""
from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

# Do not import sqlalchemy or ORM models at module scope: this module is bundled into the standalone Runner.
# runner.spec deliberately excludes database libraries from that executable.
# Importing execution_aliases must therefore remain safe without SQLAlchemy installed.
# A receipt-path import failure can otherwise leave Hub task state inconsistent with a live session.
# Import database dependencies lazily only inside operations that actually require them.
if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

from . import agent_naming

log = logging.getLogger("uvicorn.error")

SETTING_KEY = "execution_aliases"
SCOPES = ("machine", "agent")
_MAX_LEN = 40           # Bound alias length to fit compact machine and seat lists.
_MAX_ROWS = 400         # Bound the complete alias map size.


def empty() -> dict:
    return {"machine": {}, "agent": {}}


async def load(session: AsyncSession) -> dict:
    """Load aliases, returning an empty map on failure so optional naming cannot disable the
    workbench.
    """
    try:
        from .. import models
        row = await session.get(models.AppSetting, SETTING_KEY)
        data = json.loads(row.value) if row and (row.value or "").strip() else {}
    except Exception as e:  # noqa: BLE001
        log.warning("读执行机别名失败: %s", type(e).__name__)
        return empty()
    if not isinstance(data, dict):
        return empty()
    out = empty()
    for scope in SCOPES:
        got = data.get(scope)
        if isinstance(got, dict):
            out[scope] = {str(k): str(v) for k, v in got.items() if str(v).strip()}
    return out


async def set_name(session: AsyncSession, scope: str, key: str, name: str) -> dict:
    """Set a machine or seat alias; an empty name restores automatic naming."""
    scope = str(scope or "").strip()
    if scope not in SCOPES:
        raise ValueError("只能给执行机（machine）或智能体（agent）起名")
    key = str(key or "").strip()
    if not key:
        raise ValueError("要改名的对象没说清楚")
    name = " ".join(str(name or "").split())[:_MAX_LEN]

    from .. import models
    data = await load(session)
    if name:
        if len(data[scope]) >= _MAX_ROWS and key not in data[scope]:
            raise ValueError("起过名的对象太多了，先清掉一些再来")
        data[scope][key] = name
    else:
        data[scope].pop(key, None)

    row = await session.get(models.AppSetting, SETTING_KEY)
    if row is None:
        row = models.AppSetting(key=SETTING_KEY, value="")
        session.add(row)
    row.value = json.dumps(data, ensure_ascii=False)
    return data


def machine_name(aliases: dict, key: str) -> str:
    return str(((aliases or {}).get("machine") or {}).get(str(key or ""), "") or "").strip()


def agent_name(aliases: dict, desk_key: str) -> str:
    return str(((aliases or {}).get("agent") or {}).get(str(desk_key or ""), "") or "").strip()


def seat_name(aliases: dict, *, machine_key: str, cli_key: str, cli_name: str,
              machine_label: str) -> str:
    """Prefer a seat-specific alias, otherwise combine the current machine label and CLI. Machine
    renames propagate to all seats and historical views.
    """
    own = agent_name(aliases, str(machine_key) + "|" + str(cli_key))
    return own or agent_naming.display_name(cli_name, machine_label)
