# -*- coding: utf-8 -*-
"""Regression checks for public module contracts."""
import asyncio
import io
import os
import shlex
import sys
import tarfile
import tempfile
from pathlib import Path
from unittest.mock import patch

_TEMP = tempfile.TemporaryDirectory(prefix="soduwork-smoke-runner-enroll-")
DB = str(Path(_TEMP.name) / "test.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import automation_models as am  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import runner_enroll, runner_hub, runner_registry  # noqa: E402

# Exercise the real source packager without writing into the checkout or its
# deployment cache. Native atomic replacement must run on ordinary temp storage.
runner_enroll._CACHE = Path(_TEMP.name) / "cache"

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:240] if extra else ""))


class FakeRunner:
    """Build an online Runner fixture matching fields consumed by selection helpers."""

    def __init__(self, rid, client_id="", tags=(), agents=("codex",)):
        self.id, self.client_id = rid, client_id
        self.tags = list(tags)
        self.agents = [{"key": k, "name": k} for k in agents]
        self.busy, self.connected_at = 0, 1.0
        self.dispatch_mode = "accepting"
        self.ready = True
        self.inventory_ready = True
        self.host, self.os, self.version, self.work_root = rid, "Linux", "1.4.0", "/w"

    def alive(self):
        return True


async def main():
    await init_db()

    # Issue a key and generate installation commands.
    async with SessionLocal() as s:
        out = await runner_enroll.enroll(
            s, host="构建机-01", tags=["linux", "intranet"],
            hub="http://192.0.2.40:9080", org_id="org-a")
        await s.commit()
    rid, key = out["runnerId"], out["key"]
    chk("① 新机器给了 id", rid.startswith("rn-"), rid)
    chk("① 钥匙够长（高熵随机串）", len(key) >= 32, len(key))
    async with SessionLocal() as s:
        row = await s.get(am.RunnerNode, rid)
        chk("① 预注册了节点行", row is not None and row.auth_state == "active")
        chk("① 服务端只存 hash，不存明文", bool(row.secret_hash) and key not in (row.secret_hash or ""))
        chk("① 还没连过 → 待装机", not row.last_seen_at)
        chk("① 公用执行机（没有归属桌宠）", runner_registry.is_shared(row.client_id or ""))
        chk("① 标签先落下来（界面能看见预期标签）", set(row.tags or []) == {"linux", "intranet"})
        chk("① 这把钥匙认得", await runner_registry.verify_key(s, rid, key))

    win = out["commands"]["windows"]
    lin = out["commands"]["linux"]
    chk("① Windows 命令带 hub/id/key", all(x in win for x in
                                           ("192.0.2.40:9080", rid, key, "runner-install.ps1")), win[:160])
    chk("① Windows 命令带得动参数（不是裸 iex）", "[scriptblock]::Create" in win, win[:120])
    linux_tokens = shlex.split(lin)
    chk("① Linux 命令保留独立的 hub/id/key 参数",
        linux_tokens[:2] == ["bash", "-c"]
        and linux_tokens[7] == "http://192.0.2.40:9080"
        and linux_tokens[8:] == ["--hub", "http://192.0.2.40:9080",
                                 "--id", rid, "--key", key, "--tags", "linux,intranet"]
        and "/api/v1/download/runner-install.sh" in linux_tokens[5])
    chk("① 标签进了命令", "linux,intranet" in win and "linux,intranet" in lin, win[:200])

    # Rotation immediately invalidates the previous key.
    async with SessionLocal() as s:
        again = await runner_enroll.enroll(s, runner_id=rid, host="构建机-01")
        await s.commit()
    chk("① 重发＝同一台机器（id 不变）", again["runnerId"] == rid)
    chk("① 重发算轮换", again["rotated"] is True)
    chk("① 新旧钥匙不是同一把", again["key"] != key)
    async with SessionLocal() as s:
        chk("① 旧钥匙当场作废", not await runner_registry.verify_key(s, rid, key))
        chk("① 新钥匙认得", await runner_registry.verify_key(s, rid, again["key"]))

    # Avoid loopback URLs in remote installation commands.
    got = runner_enroll.hub_url("", "http://127.0.0.1:9080")
    chk("② 有局域网地址时替换管理端环回地址", got == "http://192.0.2.10:9080", got)
    chk("② 显式指定优先", runner_enroll.hub_url("http://192.0.2.3:9080", "http://127.0.0.1:9080")
        == "http://192.0.2.3:9080")
    chk("② 管理端地址像样就用它",
        runner_enroll.hub_url("", "http://192.0.2.40:9080") == "http://192.0.2.40:9080")
    chk("② 没协议也认", runner_enroll.hub_url("192.0.2.40:9080", "") == "http://192.0.2.40:9080")
    with patch.object(runner_enroll, "_lan_ip", return_value=""):
        chk("② 无出口网卡时仍优先使用明确的远程地址",
            runner_enroll.hub_url("https://hub.example.test", "http://127.0.0.1:9080")
            == "https://hub.example.test")
        chk("② 无出口网卡且无远程地址时保留本机回退，不宣称远程可达",
            runner_enroll.hub_url("", "http://127.0.0.1:9080") == "http://127.0.0.1:9080")

    # Keep shared standalone Runners visible and dispatchable in scope.
    # Do not exclude shared nodes solely because client_id is empty.
    async with SessionLocal() as s:
        s.add(am.RunnerNode(id="rn-owned", client_id="u-someone", dispatch_mode="accepting",
                            host="同事的电脑"))
        await s.commit()
    async with SessionLocal() as s:
        items = await runner_registry.list_nodes(s, {"u-other"}, {"org-a"})   # Exercise an unrelated authorization scope.
        ids = {x["runnerId"] for x in items}
        chk("③ 公用执行机在别人的作用域里也看得见", rid in ids, ids)
        chk("③ 别人名下的机器仍然筛掉", "rn-owned" not in ids, ids)
        mine = next(x for x in items if x["runnerId"] == rid)
        chk("③ 界面能认出「公用」", mine["shared"] is True)
        chk("③ 界面能认出「待装机」", mine["enrolled"] is True)

    runner_hub._RUNNERS.clear()
    runner_hub._RUNNERS["rn-shared"] = FakeRunner("rn-shared", "", tags=["linux"])
    runner_hub._RUNNERS["rn-shared"].org_id = "org-a"
    runner_hub._RUNNERS["rn-mine"] = FakeRunner("rn-mine", "u-someone", tags=["win"])
    picked = runner_hub.pick_for("u-nobody", "codex", {"u-other"},
                                 allowed_org_ids={"org-a"})
    chk("③ 派活挑得到公用执行机", picked is not None and picked.id == "rn-shared",
        picked and picked.id)
    tagged = runner_hub.pick_by_tags(["linux"], "u-nobody", {"u-other"},
                                      allowed_org_ids={"org-a"})
    chk("③ 按标签部署也挑得到", tagged is not None and tagged.id == "rn-shared",
        tagged and tagged.id)
    own_only = runner_hub.pick_for("u-someone", "codex", {"u-someone"})
    chk("③ 归属人自己那台仍然优先", own_only is not None and own_only.id == "rn-mine",
        own_only and own_only.id)
    runner_hub._RUNNERS.clear()

    # Removing a Runner registry row preserves historical execution records.
    async with SessionLocal() as s:
        s.add(am.ExecutionSession(id="es-hist", runner_id=rid, task_id="t-x",
                                  ref="ref-es-hist", state="succeeded", engine="codex"))
        await s.commit()
    async with SessionLocal() as s:
        row = await s.get(am.RunnerNode, rid)
        await s.delete(row)
        await s.commit()
    async with SessionLocal() as s:
        chk("① 退役后登记行没了", await s.get(am.RunnerNode, rid) is None)
        chk("① 干过的活还在", await s.get(am.ExecutionSession, "es-hist") is not None)

    # Verify installer scripts and packages.
    ps1 = (runner_enroll.INSTALLERS / "runner-install.ps1").read_text(encoding="utf-8")
    sh = (runner_enroll.INSTALLERS / "runner-install.sh").read_text(encoding="utf-8")
    chk("④ PS 脚本收得下 -Hub/-Id/-Key/-Tags",
        all(x in ps1 for x in ("[string]$Hub", "[string]$Id", "[string]$Key", "[string]$Tags")))
    chk("④ PS 脚本装成常驻（计划任务）", "Register-ScheduledTask" in ps1 and "-AtStartup" in ps1)
    chk("④ PS 脚本能卸载", "-Uninstall" in ps1 and "Unregister-ScheduledTask" in ps1)
    chk("④ PS 脚本下的是 win 包", "/api/v1/download/runner?os=win" in ps1)
    chk("④ sh 脚本收得下 --hub/--id/--key/--tags",
        all(x in sh for x in ("--hub)", "--id)", "--key)", "--tags)")))
    chk("④ sh 脚本装成常驻（systemd）",
        "/etc/systemd/system/${UNIT}.service" in sh and "Restart=always" in sh)
    chk("④ sh 脚本下的是源码包", "/api/v1/download/runner?os=src" in sh)
    chk("④ sh 脚本用 python 写 JSON（别用 shell 拼）", "json.dump" in sh)
    chk("④ 脚本里没有任何钥匙（可以公开下载）",
        key not in ps1 and key not in sh and again["key"] not in ps1)

    pkg = runner_enroll.source_package()
    chk("④ 源码包打得出来", pkg is not None and pkg.is_file(), pkg)
    if pkg and pkg.is_file():
        with tarfile.open(pkg) as t:
            names = set(t.getnames())
        chk("④ 包里有 runner_main.py", "hub-backend/runner_main.py" in names)
        chk("④ 包里有执行底座", "hub-backend/app/services/local_base.py" in names)
        chk("④ 包里有跨底座执行门禁",
            {"hub-backend/app/services/execution_policy.py",
             "hub-backend/app/services/execution_event_policy.py",
             "hub-backend/app/services/local_execution_policy.py"} <= names)
        chk("④ 包里有依赖单子", "hub-backend/requirements-runner.txt" in names)
        chk("④ 包里没有 __pycache__", not any("__pycache__" in n for n in names))
        # Reuse the cached package on subsequent calls.
        again_pkg = runner_enroll.source_package()
        chk("④ 打过一次就缓存住", again_pkg == pkg)

    info = runner_enroll.packages_info()
    chk("④ 包状态能报给界面", info["source"].get("available") is True, info)
    spec = (runner_enroll._BACKEND / "runner.spec").read_text(encoding="utf-8")
    chk("④ Windows Runner 也显式打入动态门禁模块",
        "app.services.execution_policy" in spec
        and "app.services.execution_event_policy" in spec
        and "app.services.local_execution_policy" in spec
        and "app.services.workspace_guard" in spec)

    print("\n%s  通过 %d / %d" % ("全绿" if not fail else "有红", ok, ok + fail))
    return 0 if not fail else 1


if __name__ == "__main__":
    async def run():
        try:
            # This offline contract smoke does not require a host LAN route.
            with (patch.object(runner_enroll, "_lan_ip", return_value="192.0.2.10"),
                  patch.dict(os.environ, {"PORT": "9080"})):
                return await main()
        finally:
            await engine.dispose()
            _TEMP.cleanup()
    raise SystemExit(asyncio.run(run()))
