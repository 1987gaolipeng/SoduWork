# -*- coding: utf-8 -*-
"""Assign historical projects and their repositories to the correct organization when confirming
ownership.
"""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-project-org-adoption.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace(chr(92), "/")
sys.path.insert(0, ".")

from sqlalchemy import select  # noqa: E402

from app import models  # noqa: E402
from app.api import admin  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402

passed = failed = 0


def check(name, value, detail=""):
    global passed, failed
    if value:
        passed += 1
        print("  PASS", name)
    else:
        failed += 1
        print("  FAIL", name, detail)


async def main():
    await init_db()
    async with SessionLocal() as session:
        org = models.OrgUnit(id="org-product", name="产品部")
        root = models.User(id="u-root", username="root", display_name="管理员",
                           password_hash="x", is_super=True, is_active=True)
        owner = models.User(id="u-owner", username="owner", display_name="负责人",
                            password_hash="x", org_id=org.id, is_active=True)
        project = models.Project(id="p-legacy", name="历史工程",
                                 owner_user_id=owner.id)
        repo = models.Repo(id="r-legacy", project_id=project.id, name="主仓库",
                           git_url="https://git.example/repo.git", local_dir="repo")
        session.add_all([org, root, owner, project, repo])
        await session.commit()

        result = await admin.update_project(
            project.id, {"ownerUserId": owner.id}, root, session)
        await session.refresh(project)
        await session.refresh(repo)
        event = (await session.execute(select(models.AuditLog).where(
            models.AuditLog.action == "project.update"
        ))).scalars().one()

        check("历史项目采用负责人所属组织", project.org_id == org.id, project.org_id)
        check("项目下历史仓库同步采用同一组织", repo.org_id == org.id, repo.org_id)
        check("项目 API 返回负责人", result.get("ownerUserId") == owner.id, result)
        check("审计记录迁移仓库数量",
              (event.detail or {}).get("migratedRepos") == 1, event.detail)

    await engine.dispose()
    for suffix in ("", "-shm", "-wal"):
        try:
            os.remove(DB + suffix)
        except FileNotFoundError:
            pass
    print("project org adoption: %s/%s" % (passed, passed + failed))
    if failed:
        raise SystemExit(1)


asyncio.run(main())
