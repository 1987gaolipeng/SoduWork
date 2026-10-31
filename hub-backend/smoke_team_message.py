# -*- coding: utf-8 -*-
"""Smoke-test short @mention notices with the same organization-wide scope as forwarding; publish
notices only.
"""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-team-message.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import team  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:240] if extra else ""))


async def main():
    await init_db()
    async with SessionLocal() as s:
        s.add(models.OrgUnit(id="o-1", name="产品部"))
        s.add(models.OrgUnit(id="o-2", name="外部部门"))
        s.add(models.User(id="u-me", username="me", display_name="发送人",
                          org_id="o-1", is_active=True))
        s.add(models.User(id="u-mate", username="mate", display_name="同事甲",
                          org_id="o-1", is_active=True))
        s.add(models.User(id="u-nobox", username="nobox", display_name="没盒子的同事",
                          org_id="o-1", is_active=True))
        s.add(models.User(id="u-out", username="out", display_name="别的部门",
                          org_id="o-2", is_active=True))
        s.add(models.Client(id="c-me", name="我的 SoduWork", user_ref="u-me", auth_state="active"))
        s.add(models.Client(id="c-mate", name="同事的 SoduWork", user_ref="u-mate", auth_state="active"))
        s.add(models.Client(id="c-out", name="跨部门同事的 SoduWork", user_ref="u-out", auth_state="active"))
        await s.commit()

    from app import realtime
    pushed = []
    real_pub = realtime.hub.publish

    async def fake_pub(cid, msg, *, user_id=None):
        pushed.append((cid, msg))
    realtime.hub.publish = fake_pub
    try:
        async with SessionLocal() as s:
            me = await s.get(models.Client, "c-me")

            directory = await team.my_teammates(s, me)
            chk("企业目录包含其他部门的在职同事",
                {m.get("id") for m in directory.get("mates", [])}
                == {"u-mate", "u-nobox", "u-out"}, directory)

            chk("目录返回稳定部门ID与公开组织列表",
                {row['id'] for row in directory['orgUnits']} == {'o-1', 'o-2'}
                and all(m.get('orgId') in {'o-1', 'o-2'} for m in directory['mates'])
                and all(set(row) == {'id', 'name', 'parentId'} for row in directory['orgUnits']), directory)

            r = await team.message_mate(s, me, "u-mate", "  项目进展：接口联调完成，明天出包  ")
            chk("同部门同事能收到", r.get("ok") is True, r)
            notices = [(cid, event) for cid, event in pushed if event.get("type") == "notice"]
            chk("推送到对方 SoduWork，带发送人名字",
                len(notices) == 1 and notices[0][0] == "c-mate"
                and "发送人" in notices[0][1]["text"] and "接口联调完成" in notices[0][1]["text"],
                pushed)
            chk("kind 标成同事留言（通知中心能按类归档）",
                notices[0][1].get("kind") == "mate_message", notices[0][1])
            chk("回执如实等待客户端接收确认",
                r.get("delivered") is False and r.get("status") == "accepted", r)

            r = await team.message_mate(s, me, "u-out", "跨部门喊话")
            chk("跨部门同事也能收到企业协作通知",
                r.get("ok") is True and any(cid == "c-out" for cid, _ in pushed), (r, pushed))

            r = await team.message_mate(s, me, "u-nobox", "他没有 SoduWork")
            chk("对方没装 SoduWork 要明说", r.get("ok") is False and r.get("reason") == "no_box", r)

            r = await team.message_mate(s, me, "u-mate", "   ")
            chk("空消息拦下", r.get("ok") is False and r.get("reason") == "empty", r)

            r = await team.message_mate(s, me, "u-me", "给自己发")
            chk("不能发给自己", r.get("ok") is False, r)
    finally:
        realtime.hub.publish = real_pub

    print(f"\n{ok} PASS / {fail} FAIL")
    return fail


if __name__ == "__main__":
    sys.exit(1 if asyncio.run(main()) else 0)
