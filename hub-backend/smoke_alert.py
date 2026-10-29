# -*- coding: utf-8 -*-
"""Verify workflow-failure notifications reach all stakeholder devices, delivery failures also use
configured external alerts, unconfigured webhooks send nothing, and alert failures do not affect
business state.
"""
import asyncio
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

DB = os.path.abspath(".smoke-alert.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import notify  # noqa: E402

ok = fail = 0
GOT: list[dict] = []
PUSHED: list[tuple[str, dict]] = []
AUDIENCES: list[tuple[str, str]] = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:240] if extra else ""))


class Hook(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        GOT.append(json.loads(self.rfile.read(n).decode("utf-8")))
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")


async def main():
    await init_db()
    srv = HTTPServer(("127.0.0.1", 0), Hook)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/robot" % srv.server_port

    # Capture in-app recipients in memory; this test covers routing rather than WebSocket transport.
    async def fake_publish(cid, ev, *, user_id=None):
        expected_accounts = {"c-owner": "u-owner", "c-req1": "u-req", "c-req2": "u-req"}
        assert user_id == expected_accounts.get(cid), "Notification lost its account routing fence."
        PUSHED.append((cid, ev))
        AUDIENCES.append((cid, user_id))
    notify.hub.publish = fake_publish

    async with SessionLocal() as s:
        s.add(models.User(id="u-owner", username="owner", display_name="负责人"))
        s.add(models.User(id="u-req", username="req", display_name="提出者"))
        s.add(models.Client(id="c-owner", name="负责人的电脑", secret="x", user_ref="u-owner"))
        s.add(models.Client(id="c-req1", name="提出者的电脑", secret="x", user_ref="u-req"))
        s.add(models.Client(id="c-req2", name="提出者的笔记本", secret="x", user_ref="u-req"))
        s.add(models.Client(id="c-other", name="不相干的人", secret="x", user_ref="u-x"))
        s.add(models.Task(id="t1", title="发一版到预发", status="doing",
                          owner_client_id="c-owner", owner_user_id="u-owner", requester_user_id="u-req"))
        await s.commit()

    # Notify every relevant stakeholder device.
    async with SessionLocal() as s:
        task = await s.get(models.Task, "t1")
        n = await notify.notify_task(s, task, "上线核对没过")
    got = {cid for cid, _ in PUSHED}
    chk("① 相关人名下的设备全推到（一人多机也全推）",
        got == {"c-owner", "c-req1", "c-req2"}, got)
    chk("① 不相干的人不推", "c-other" not in got, got)
    chk("① 回的是真推到的设备数", n == 3, n)
    chk("① 推送绑定当前接收账号，设备不能跨账号复用通知", set(AUDIENCES) == {
        ("c-owner", "u-owner"), ("c-req1", "u-req"), ("c-req2", "u-req")}, AUDIENCES)

    # Do not send external alerts without configuration.
    async with SessionLocal() as s:
        task = await s.get(models.Task, "t1")
        sent = await notify.alert(s, "上线核对没过")
    chk("② webhook 没配就不发（也不报错）", sent is False and not GOT, GOT)

    # Use a webhook payload compatible with supported receivers.
    async with SessionLocal() as s:
        s.add(models.AppSetting(key=notify.ALERT_URL_KEY, value=url))
        await s.commit()
    async with SessionLocal() as s:
        task = await s.get(models.Task, "t1")
        sent = await notify.alert(s, "上线核对没过：关键接口不能报错（返回 500）", task=task)
    chk("③ 配了地址就真发出去了", sent is True and len(GOT) == 1, GOT)
    body = GOT[0] if GOT else {}
    chk("③ 企业微信/钉钉认的形状在", (body.get("text") or {}).get("content", "").startswith("【SoduWork】"), body)
    chk("③ 飞书认的形状也在", (body.get("content") or {}).get("text", "") != "", body)
    chk("★③ 正文带任务标题和原因（人可能是在手机上看到这条）",
        "发一版到预发" in json.dumps(body, ensure_ascii=False)
        and "关键接口" in json.dumps(body, ensure_ascii=False), body)

    # External delivery failure remains nonfatal.
    async with SessionLocal() as s:
        row = (await s.execute(
            __import__("sqlalchemy").select(models.AppSetting).where(
                models.AppSetting.key == notify.ALERT_URL_KEY))).scalars().first()
        row.value = "http://127.0.0.1:9/nowhere"      # Use an unserved local port for the failure case.
        await s.commit()
    async with SessionLocal() as s:
        task = await s.get(models.Task, "t1")
        try:
            sent = await notify.alert(s, "打不通也得稳住", task=task)
            crashed = False
        except Exception:  # noqa: BLE001
            sent, crashed = None, True
    chk("★④ 告警发不出去时不抛异常（主流程不能被通知带下去）",
        crashed is False and sent is False, (crashed, sent))

    # Exercise both notification channels together.
    GOT.clear()
    PUSHED.clear()
    async with SessionLocal() as s:
        row = (await s.execute(
            __import__("sqlalchemy").select(models.AppSetting).where(
                models.AppSetting.key == notify.ALERT_URL_KEY))).scalars().first()
        row.value = url
        await s.commit()
    async with SessionLocal() as s:
        task = await s.get(models.Task, "t1")
        out = await notify.notify_and_alert(s, task, "⚠️卡在「建版本并部署」")
    chk("⑤ 关键节点两条通道各走一次",
        out == {"devices": 3, "webhook": True} and len(GOT) == 1, (out, len(GOT)))

    srv.shutdown()
    print("\n%s  通过 %d / %d" % ("全绿" if not fail else "有红", ok, ok + fail))
    return 0 if not fail else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
