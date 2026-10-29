# -*- coding: utf-8 -*-
"""Offline per-Runner key tests for issuance, hash-only storage, verification, rotation, and
targeted revocation. Preserve device-key and explicitly supported legacy authentication paths.
"""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-runnerkey.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.api import runner_ws  # noqa: E402
from app.services import device_auth, runner_registry as rr  # noqa: E402

ok = fail = 0
DEVICE_SECRET = "device-secret-" + ("x" * 36)


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


async def main():
    await init_db()

    # Preregister the Runner and store only its key hash.
    async with SessionLocal() as s:
        key_a = await rr.issue_key(s, "build-01", host="构建机一号")
        key_b = await rr.issue_key(s, "build-02", host="构建机二号")
        await s.commit()
    chk("发钥回明文（urlsafe 长随机串）", len(key_a) >= 40 and key_a != key_b, (len(key_a),))
    async with SessionLocal() as s:
        row = await s.get(am.RunnerNode, "build-01")
        chk("没连过的机器发钥即预注册（host 记上）",
            row is not None and row.host == "构建机一号" and row.auth_state == "active", row)
        chk("库里只有哈希、没有明文", key_a not in (row.secret_hash or "")
            and len(row.secret_hash) == 64, row.secret_hash[:16])

    # Verify machine keys.
    async with SessionLocal() as s:
        chk("对的钥匙验过", await rr.verify_key(s, "build-01", key_a))
        chk("错的钥匙拒绝", not await rr.verify_key(s, "build-01", key_b))
        chk("不存在的机器拒绝", not await rr.verify_key(s, "ghost", key_a))

    # Invalidate the old key during rotation.
    async with SessionLocal() as s:
        key_a2 = await rr.issue_key(s, "build-01")
        await s.commit()
    async with SessionLocal() as s:
        chk("轮换后旧钥作废、新钥可用",
            not await rr.verify_key(s, "build-01", key_a)
            and await rr.verify_key(s, "build-01", key_a2))

    # Revocation affects only the selected machine.
    async with SessionLocal() as s:
        await rr.revoke_key(s, "build-01")
        await s.commit()
    async with SessionLocal() as s:
        row = await s.get(am.RunnerNode, "build-01")
        chk("吊销：状态 revoked、哈希清空",
            row.auth_state == "revoked" and not row.secret_hash, (row.auth_state, row.secret_hash))
        chk("吊销那台的钥匙失效", not await rr.verify_key(s, "build-01", key_a2))
        chk("★其余机器不受影响", await rr.verify_key(s, "build-02", key_b))

    # Exercise supported authentication modes.
    async with SessionLocal() as s:
        s.add(models.Client(id="c-key", name="桌宠",
                            secret_hash=device_auth.hash_secret(DEVICE_SECRET),
                            auth_state="active", user_ref="u-key"))
        s.add(models.AppSetting(key="runner_token", value="shared-token"))
        s.add(models.User(id="u-key", username="runner-key-smoke",
                          display_name="Runner key smoke", is_active=True))
        await s.commit()
    okk, why = await runner_ws._auth("", "192.0.2.9", device="c-key", secret=DEVICE_SECRET)
    chk("① 设备密钥口径不动", okk, why)
    okk, why = await runner_ws._auth("", "192.0.2.9", device="c-key", secret="wrong")
    chk("① 设备密钥错拒绝", not okk)
    okk, why = await runner_ws._auth("", "192.0.2.9", runner_id="build-02", runner_key=key_b)
    chk("② 一机一钥放行", okk, why)
    okk, why = await runner_ws._auth("", "192.0.2.9", runner_id="build-01", runner_key=key_a2)
    chk("② 已吊销的钥匙拒绝", not okk and "吊销" in why, why)
    okk, why = await runner_ws._auth("shared-token", "192.0.2.9")
    chk("③ 共享令牌过渡期仍可用", okk, why)
    okk, why = await runner_ws._auth("bad-token", "192.0.2.9")
    chk("③ 共享令牌错拒绝", not okk)
    # Verify loopback behavior when no shared token is configured.
    from sqlalchemy import delete as _del
    async with SessionLocal() as s:
        await s.execute(_del(models.AppSetting).where(models.AppSetting.key == "runner_token"))
        await s.commit()
    okk, why = await runner_ws._auth("", "127.0.0.1")
    chk("④ 未配令牌只认本机回环", okk, why)
    okk, why = await runner_ws._auth("", "192.0.2.9")
    chk("④ 未配令牌拒绝远程", not okk)

    # Verify administration visibility.
    async with SessionLocal() as s:
        items = await rr.list_nodes(s)
        states = {x["runnerId"]: x.get("authState") for x in items}
        chk("列表带 authState（UI 显示鉴权口径）",
            states.get("build-01") == "revoked" and states.get("build-02") == "active", states)

    print(f"\n{ok} PASS / {fail} FAIL")
    return fail


if __name__ == "__main__":
    try:
        rc = asyncio.run(main())
    finally:
        asyncio.run(engine.dispose())
        for suffix in ("", "-shm", "-wal"):
            try:
                os.remove(DB + suffix)
            except FileNotFoundError:
                pass
    sys.exit(1 if rc else 0)
