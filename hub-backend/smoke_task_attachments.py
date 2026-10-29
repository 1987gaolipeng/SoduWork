# -*- coding: utf-8 -*-
"""Task attachment participant permissions smoke test. Runs on an isolated DB."""
import asyncio
import io
import os
import sys

from fastapi import HTTPException, UploadFile
from starlette.datastructures import Headers

DB = os.path.abspath(".smoke-task-attachments.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import models  # noqa: E402
from app.api import attachments as api  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import storage  # noqa: E402

passed = failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print("  PASS  " + name)
    else:
        failed += 1
        print("  FAIL  " + name + (" :: " + str(detail)[:240] if detail else ""))


def upload(name, payload=b"proof"):
    return UploadFile(
        filename=name,
        file=io.BytesIO(payload),
        headers=Headers({"content-type": "text/plain"}),
    )


async def status_of(awaitable):
    try:
        await awaitable
    except HTTPException as error:
        return error.status_code
    return 200


async def main():
    await init_db()
    blobs = {}
    real_put, real_delete = storage.put, storage.delete
    storage.put = lambda key, data, _content_type: (
        blobs.__setitem__(key, bytes(data)) or "memory")
    storage.delete = lambda key, _backend: blobs.pop(key, None)
    try:
        async with SessionLocal() as session:
            session.add_all([
                models.User(id="user-owner", username="owner", display_name="Owner"),
                models.User(id="user-creator", username="creator", display_name="Creator"),
                models.User(id="user-requester", username="requester", display_name="Requester"),
                models.User(id="user-other", username="other", display_name="Other"),
                models.Client(id="box-owner", name="Owner PC", user_ref="user-owner",
                              auth_state="active"),
                models.Client(id="box-creator", name="Creator PC", user_ref="user-creator",
                              auth_state="active"),
                models.Client(id="box-requester", name="Requester PC", user_ref="user-requester",
                              auth_state="active"),
                models.Client(id="box-other", name="Other PC", user_ref="user-other",
                              auth_state="active"),
                models.Task(
                    id="task-attachment", title="Attachment contract", status="todo",
                    origin="dispatch", owner_client_id="box-owner",
                    created_by="user-creator", assignee_user_id="user-owner",
                    requester_user_id="user-requester",
                ),
            ])
            await session.commit()

            owner = await session.get(models.Client, "box-owner")
            creator = await session.get(models.Client, "box-creator")
            requester = await session.get(models.Client, "box-requester")
            other = await session.get(models.Client, "box-other")

            created = await api.upload_attachment(
                "task-attachment", upload("creator-proof.txt"), creator, session)
            check("creator participant can upload", created.get("canDelete") is True, created)

            requester_view = await api.list_attachments(
                "task-attachment", requester, session)
            check("requester can view but cannot delete another upload",
                  len(requester_view) == 1 and requester_view[0].get("canDelete") is False,
                  requester_view)

            other_status = await status_of(
                api.list_attachments("task-attachment", other, session))
            check("unrelated device cannot list task attachments", other_status == 404,
                  other_status)

            requester_delete = await status_of(
                api.delete_attachment(created["id"], requester, session))
            check("participant cannot delete another participant upload",
                  requester_delete == 404, requester_delete)

            own_delete = await status_of(
                api.delete_attachment(created["id"], creator, session))
            check("uploader can delete own attachment", own_delete == 200, own_delete)

            second = await api.upload_attachment(
                "task-attachment", upload("owner-cleanup.txt"), creator, session)
            owner_view = await api.list_attachments("task-attachment", owner, session)
            check("execution device can clean all task attachments",
                  len(owner_view) == 1 and owner_view[0].get("canDelete") is True,
                  owner_view)
            owner_delete = await status_of(
                api.delete_attachment(second["id"], owner, session))
            check("execution device deletion succeeds", owner_delete == 200, owner_delete)
            check("storage cleanup follows metadata deletion", not blobs, blobs)
    finally:
        storage.put, storage.delete = real_put, real_delete


if __name__ == "__main__":
    try:
        asyncio.run(main())
        print("\n%d PASS / %d FAIL" % (passed, failed))
    finally:
        asyncio.run(engine.dispose())
        for suffix in ("", "-shm", "-wal"):
            try:
                os.remove(DB + suffix)
            except FileNotFoundError:
                pass
    raise SystemExit(1 if failed else 0)
