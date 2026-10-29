# -*- coding: utf-8 -*-
"""Regression checks for public module contracts."""
import asyncio
import os
import sys
from unittest.mock import patch

DB = os.path.abspath(".smoke-exec-names.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import agent_naming, ai_exec, aidesk_view, execution_aliases  # noqa: E402

ok = fail = 0
lines = []
HERE = "DESKTOP-FIXTURE"          # Backend-host fixture.


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        lines.append("  PASS  " + name)
    else:
        fail += 1
        lines.append("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


def _ev(tid, name, cli, provider, host="", rid=""):
    return models.TaskEvent(task_id=tid, kind=ai_exec.EV_DISPATCHED,
                            detail={"ref": "ref-" + tid, "assigneeName": name,
                                    "assigneeCli": cli, "provider": provider,
                                    "host": host, "runnerId": rid})


def _roster(aliases):
    """Return a synthetic online roster: four local runtimes and two remote runtimes matching ai_local/ai_remote event shapes."""
    out = []
    for key, label in (("pi", "Pi"), ("opencode", "OpenCode"),
                       ("claude", "Claude Code"), ("codex", "Codex")):
        mk = agent_naming.machine_key(host=HERE)
        out.append({"id": "local:" + key, "cli": key, "cliName": label, "local": True,
                    "online": True, "host": HERE, "machineKey": mk,
                    "name": execution_aliases.seat_name(
                        aliases, machine_key=mk, cli_key=key, cli_name=label,
                        machine_label=execution_aliases.machine_name(aliases, mk) or HERE)})
    # Merge an embedded Runner with the local adapter on the same physical machine.
    # Retain its Runner ID for real session and terminal routing.
    for key, label in (("pi", "Pi"), ("opencode", "OpenCode")):
        mk = agent_naming.machine_key(host=HERE)
        out.append({"id": "runner:fedcba987654:" + key, "cli": key, "cliName": label,
                    "remote": True, "online": True, "host": HERE,
                    "runnerId": "fedcba987654", "machineKey": mk,
                    "machineLabel": execution_aliases.machine_name(aliases, mk) or HERE,
                    "name": execution_aliases.seat_name(
                        aliases, machine_key=mk, cli_key=key, cli_name=label,
                        machine_label=execution_aliases.machine_name(aliases, mk) or HERE)})
    for key, label in (("pi", "Pi"), ("opencode", "OpenCode")):
        mk = agent_naming.machine_key(host="012345abcdef")
        out.append({"id": "runner:runner-trial-dev:" + key, "cli": key, "cliName": label,
                    "remote": True, "online": True, "host": "012345abcdef",
                    "runnerId": "runner-trial-dev", "machineKey": mk,
                    "machineLabel": execution_aliases.machine_name(aliases, mk) or "012345abcdef(Linux)",
                    "name": execution_aliases.seat_name(
                        aliases, machine_key=mk, cli_key=key, cli_name=label,
                        machine_label=execution_aliases.machine_name(aliases, mk) or "012345abcdef(Linux)")})
    return {"agents": out, "squads": []}


async def _view(session, box, aliases):
    ctx = {"name": "local", "cfg": {"names": aliases}}
    # Legacy local events deliberately omit host; the fixture's local host
    # must match its roster instead of depending on the machine running CI.
    with patch.object(aidesk_view.ai_local, "local_host", return_value=HERE):
        return await aidesk_view.build(session, box, ctx, _roster(aliases))


async def main():
    await init_db()
    async with SessionLocal() as session:
        box = models.Client(id="c-names", name="起名冒烟 SoduWork")
        session.add(box)
        # Include all supported historical dispatch forms.
        cases = [
            ("t1", "DESKTOP-FIXTURE · Pi", "pi", "runner", HERE, "fedcba987654"),
            ("t2", "DESKTOP-FIXTURE · OpenCode", "opencode", "runner", HERE, "fedcba987654"),
            ("t3", "012345abcdef · OpenCode", "opencode", "runner", "012345abcdef", "runner-trial-dev"),
            ("t4", "012345abcdef · Pi", "pi", "runner", "012345abcdef", "runner-trial-dev"),
            # Legacy forms that previously produced duplicate seats.
            ("t5", "阿码", "OpenCode", "multica", "", ""),                 # Retired managed-provider execution.
            ("t6", "本机 OpenCode", "OpenCode", "local", "", ""),          # Legacy local-seat naming.
            ("t7", "DESKTOP-FIXTURE · Pi", "", "local", "", ""),           # Missing historical runtime field.
        ]
        for tid, name, cli, prov, host, rid in cases:
            session.add(models.Task(id=tid, owner_client_id=box.id, title="活 " + tid, status="done"))
            session.add(_ev(tid, name, cli, prov, host, rid))
        await session.commit()

        # Verify seat counts without aliases.
        aliases = await execution_aliases.load(session)
        view = await _view(session, box, aliases)
        desks = view["desks"]
        live = [d for d in desks if not d["historyOnly"]]
        hist = [d for d in desks if d["historyOnly"]]
        by_key = {d["key"]: d for d in desks}

        chk("★★同一台机器的 Pi 只剩一张卡（真机上曾是三张）",
            len([d for d in desks if d["cliKey"] == "pi"
                 and d["machineKey"] == agent_naming.machine_key(host=HERE)]) == 1,
            [(d["key"], d["name"]) for d in desks if d["cliKey"] == "pi"])
        chk("★★那张 Pi 卡把三条历史都收进来了",
            by_key[agent_naming.machine_key(host=HERE) + "|pi"]["doneCount"] == 2,
            by_key.get(agent_naming.machine_key(host=HERE) + "|pi"))
        chk("★★合并席位保留客户端 Runner 精确路由",
            by_key[agent_naming.machine_key(host=HERE) + "|pi"]["runnerId"] == "fedcba987654",
            by_key.get(agent_naming.machine_key(host=HERE) + "|pi"))
        chk("★同一台机器的 OpenCode 也只剩一张",
            len([d for d in desks if d["cliKey"] == "opencode"
                 and d["machineKey"] == agent_naming.machine_key(host=HERE)]) == 1)
        chk("★trial 那台没被并进本机（是两台机器）",
            agent_naming.machine_key(host="012345abcdef") + "|opencode" in by_key)
        chk("★退役底座的席位折进历史，不占在线格子",
            [d["name"] for d in hist] == ["阿码"], [d["name"] for d in hist])
        chk("★在线席位＝名单里那 6 个，不多不少", len(live) == 6, [d["name"] for d in live])
        chk("在线席位默认名认得出是哪台",
            sorted({d["name"] for d in live}) == sorted([
                "012345abcdef(Linux) · OpenCode", "012345abcdef(Linux) · Pi",
                "DESKTOP-FIXTURE · Claude Code", "DESKTOP-FIXTURE · Codex",
                "DESKTOP-FIXTURE · OpenCode", "DESKTOP-FIXTURE · Pi"]),
            sorted({d["name"] for d in live}))
        chk("历史席位排在最后，不和在线的抢位置", desks[-1]["historyOnly"] is True)

        # Rename an entire machine.
        mk_here = agent_naming.machine_key(host=HERE)
        await execution_aliases.set_name(session, "machine", mk_here, "我的开发机")
        await session.commit()
        aliases = await execution_aliases.load(session)
        view = await _view(session, box, aliases)
        names = {d["key"]: d["name"] for d in view["desks"]}
        chk("★★给机器起名，它上面所有席位一起改",
            names[mk_here + "|pi"] == "我的开发机 · Pi"
            and names[mk_here + "|opencode"] == "我的开发机 · OpenCode"
            and names[mk_here + "|codex"] == "我的开发机 · Codex", names)
        chk("★另一台机器不受影响",
            names[agent_naming.machine_key(host="012345abcdef") + "|pi"] == "012345abcdef(Linux) · Pi",
            names)
        chk("★改名不换身份键（历史没被劈成两张卡）",
            view["desks"] and all(d["key"] in names for d in view["desks"])
            and len(view["desks"]) == len(desks), (len(view["desks"]), len(desks)))
        chk("改完名工作台照样回得出机器别名",
            {d["machineAlias"] for d in view["desks"] if d["machineKey"] == mk_here} == {"我的开发机"})

        # Rename one agent seat independently.
        await execution_aliases.set_name(session, "agent", mk_here + "|pi", "小P")
        await session.commit()
        aliases = await execution_aliases.load(session)
        names = {d["key"]: d["name"] for d in (await _view(session, box, aliases))["desks"]}
        chk("★席位自己的名字盖过机器名", names[mk_here + "|pi"] == "小P", names)
        chk("同机器上别的席位仍跟着机器名", names[mk_here + "|opencode"] == "我的开发机 · OpenCode")

        # Clearing a name restores automatic naming.
        await execution_aliases.set_name(session, "agent", mk_here + "|pi", "")
        await execution_aliases.set_name(session, "machine", mk_here, "   ")
        await session.commit()
        aliases = await execution_aliases.load(session)
        names = {d["key"]: d["name"] for d in (await _view(session, box, aliases))["desks"]}
        chk("★清空后回到自动名", names[mk_here + "|pi"] == "DESKTOP-FIXTURE · Pi", names)
        chk("清空后库里不留空壳",
            not execution_aliases.machine_name(aliases, mk_here)
            and not execution_aliases.agent_name(aliases, mk_here + "|pi"), aliases)

        # Validate alias boundaries.
        await execution_aliases.set_name(session, "machine", mk_here, "  前后  空白   压掉  ")
        await session.commit()
        aliases = await execution_aliases.load(session)
        chk("名字里连续空白压成一个", execution_aliases.machine_name(aliases, mk_here) == "前后 空白 压掉",
            execution_aliases.machine_name(aliases, mk_here))
        await execution_aliases.set_name(session, "machine", mk_here, "长" * 80)
        await session.commit()
        aliases = await execution_aliases.load(session)
        chk("★名字有上限，长到排不下的截掉",
            len(execution_aliases.machine_name(aliases, mk_here)) == 40)
        bad = None
        try:
            await execution_aliases.set_name(session, "什么范围", "x", "y")
        except ValueError as exc:
            bad = str(exc)
        chk("范围写错要报错，不能默默写进去", bad is not None, bad)
        bad2 = None
        try:
            await execution_aliases.set_name(session, "machine", "", "名字")
        except ValueError as exc:
            bad2 = str(exc)
        chk("没说清给谁改名要报错", bad2 is not None, bad2)

        # Malformed alias data must not disable the workbench.
        row = await session.get(models.AppSetting, execution_aliases.SETTING_KEY)
        row.value = "{这不是 JSON"
        await session.commit()
        chk("★别名存坏了也退回空表，工作台照常开",
            await execution_aliases.load(session) == execution_aliases.empty())

    print("\n".join(lines))
    print("\nexecution names smoke: %d passed, %d failed" % (ok, fail))
    return 1 if fail else 0


sys.exit(asyncio.run(main()))
