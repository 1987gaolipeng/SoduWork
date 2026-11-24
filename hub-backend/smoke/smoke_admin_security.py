# -*- coding: utf-8 -*-
"""Management writes are deny-by-default and department-tree mutations stay scoped."""
from __future__ import annotations

import asyncio
import ast
import inspect
import json
import os
from pathlib import Path
import tempfile
import textwrap
from types import SimpleNamespace
from unittest.mock import patch


_tmp = tempfile.TemporaryDirectory(prefix="soduwork-smoke-admin-security-")
os.environ["DATABASE_URL"] = (
    "sqlite+aiosqlite:///" + (Path(_tmp.name) / "security.db").as_posix())
CONSOLE_ORIGIN = "https://console.example.test"
os.environ["CORS_ORIGINS"] = CONSOLE_ORIGIN

import httpx  # noqa: E402
from fastapi import Response  # noqa: E402
from sqlalchemy import func, select  # noqa: E402
from route_test_support import api_routes  # noqa: E402

from app import automation_models as am, models  # noqa: E402
from app.auth import sign_token  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.deps import current_user  # noqa: E402
from app.main import app  # noqa: E402


passed = failed = 0
MUTATIONS = {"POST", "PUT", "PATCH", "DELETE"}
AUDIT_EXEMPT = {
    ("POST", "/api/v1/admin/login"): "authentication entry",
    ("POST", "/api/v1/admin/me/inbox/{tid}/claim"): "authenticated self-service claim",
    ("POST", "/api/v1/admin/alert-config/test"): "non-persistent probe",
    ("POST", "/api/v1/admin/capabilities/mcp/preflight"): "preflight only",
    ("POST", "/api/v1/admin/capabilities/policy/preview"): "read-only Skill policy impact preview",
    ("POST", "/api/v1/admin/capabilities/skills/preflight"): "preflight only",
    ("POST", "/api/v1/admin/deployment-targets/{target_id}/probe"): "non-persistent probe",
    ("POST", "/api/v1/admin/dev-flow/preview"): "preview only",
    ("POST", "/api/v1/admin/environment-preflight"): "preflight only",
    ("POST", "/api/v1/admin/integrations/{integration_id}/pull-account/test"): "non-persistent probe",
    ("POST", "/api/v1/admin/mcp-servers/probe"): "non-persistent probe",
    ("POST", "/api/v1/admin/model-providers/test-connection"): "read-only model list probe using draft settings",
    ("POST", "/api/v1/admin/plugins/preflight"): "preflight only",
    ("POST", "/api/v1/admin/plugins/versions/{version_id}/simulate"): "simulation only",
    ("POST", "/api/v1/admin/quotas/members/{uid}/preview"): "preview only",
    ("POST", "/api/v1/admin/quotas/plans/preview"): "preview only",
    ("POST", "/api/v1/admin/runners/{runner_id}/probe"): "non-persistent probe",
    ("POST", "/api/v1/admin/secret-references/{ref_id}/probe"): "non-persistent probe",
}


def check(name: str, condition: bool, detail="") -> None:
    global passed, failed
    if condition:
        passed += 1
        print("  PASS  " + name)
    else:
        failed += 1
        print("  FAIL  " + name + ("  << " + str(detail)[:500] if detail else ""))


async def admin_cache_contract(client, headers):
    def check_headers(label, reply, status, *vary):
        fields = [field.strip().lower() for field in reply.headers.get("vary", "").split(",")]
        check(label, reply.status_code == status and reply.headers.get("cache-control") == "no-store"
              and all(fields.count(field) == 1 for field in vary),
              (reply.status_code, reply.headers.get("cache-control"), fields))

    for path in ("users", "audit", "orgs", "llm-config", "mail-settings", "quotas", "alert-config"):
        reply = await client.get(f"/api/v1/admin/{path}", headers={**headers, "Origin": CONSOLE_ORIGIN})
        check_headers(f"admin/{path} keeps origin and varies by authorization", reply, 200, "origin", "authorization")

    denied = await client.get("/api/v1/admin/users")
    check_headers("authentication errors use the same cache policy", denied, 401, "authorization")

    for extra in (None, "aUtHoRiZaTiOn"):
        payload = Response(headers={"Vary": "Accept-Language", "Cache-Control": "public, max-age=60"})
        payload.headers.append("Vary", "Accept-Encoding")
        if extra:
            payload.headers.append("Vary", extra)
        with patch("app.api.admin._me_payload", return_value=payload):
            reply = await client.get("/api/v1/admin/me", headers=headers)
        check_headers("admin policy preserves all Vary fields and prevents route caching",
                      reply, 200, "accept-language", "accept-encoding", "authorization")

    with patch("app.api.admin._me_payload", side_effect=RuntimeError("fixture")):
        error = await client.get("/api/v1/admin/me", headers=headers)
    check_headers("unexpected admin errors use the same cache policy", error, 500, "authorization")

    other = await client.get("/api/v1/administration", headers=headers)
    check("similarly named paths stay outside the admin cache policy",
          other.status_code == 404 and "authorization" not in other.headers.get("vary", "").lower())


def dependency_calls(dependant):
    for child in dependant.dependencies:
        yield child.call
        yield from dependency_calls(child)


def permission_contract() -> None:
    routes = []
    missing = []
    for route in api_routes(app):
        methods = set(route.methods or ()) & MUTATIONS
        if not methods or not route.path.startswith("/api/v1/admin"):
            continue
        routes.append(route)
        calls = list(dependency_calls(route.dependant))
        permissions = {
            permission
            for call in calls
            for permission in getattr(call, "__soduwork_permissions__", ())
        }
        if route.path == "/api/v1/admin/login":
            continue
        if route.path == "/api/v1/admin/me/inbox/{tid}/claim":
            if current_user not in calls:
                missing.append((route.path, sorted(methods), "current_user"))
            continue
        if not permissions:
            missing.append((route.path, sorted(methods), "permission"))
    check("management mutation inventory is not vacuous", len(routes) >= 139, len(routes))
    check("every management mutation has an explicit authorization contract",
          not missing, missing)


def transactional_audit(source: str) -> bool:
    """Recognize a direct audit write followed by a commit on the same session.

    Keep this conservative: comments, nested helpers and conditional writes do
    not establish that a route persists an audit event. Runtime lifecycle tests
    separately verify that state, notices and audit rows roll back together.
    """
    for endpoint in ast.parse(textwrap.dedent(source)).body:
        if not isinstance(endpoint, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for write, commit in zip(endpoint.body, endpoint.body[1:]):
            if not (isinstance(write, ast.Expr) and isinstance(write.value, ast.Call)
                    and isinstance(commit, ast.Expr) and isinstance(commit.value, ast.Await)
                    and isinstance(commit.value.value, ast.Call)):
                continue
            call, flush = write.value, commit.value.value
            if (isinstance(call.func, ast.Attribute)
                    and isinstance(call.func.value, ast.Name)
                    and call.func.value.id == "audit" and call.func.attr == "add"
                    and len(call.args) >= 2 and isinstance(call.args[0], ast.Name)
                    and isinstance(flush.func, ast.Attribute)
                    and isinstance(flush.func.value, ast.Name)
                    and flush.func.value.id == call.args[0].id
                    and flush.func.attr == "commit"):
                return True
    return False


def transactional_audit_contract() -> None:
    cases = [
        ("accepts a staged audit followed by its commit",
         'audit.add(\n    session, user, "change", "plugin", "id")\nawait session.commit()', True),
        ("rejects a missing audit write", "await session.commit()", False),
        ("rejects an uncommitted audit", 'audit.add(session, user, "change")', False),
        ("rejects a commit before the audit",
         'await session.commit()\naudit.add(session, user, "change")', False),
        ("rejects a different session commit",
         'audit.add(session, user, "change")\nawait other.commit()', False),
        ("ignores audit text in comments and strings",
         '# audit.add(session, user, "change")\n"audit.add(session, user)"\nawait session.commit()', False),
        ("rejects a conditional audit",
         'if user.is_super:\n    audit.add(session, user, "change")\nawait session.commit()', False),
        ("ignores uncalled nested helpers",
         'async def unused():\n    audit.add(session, user, "change")\n    await session.commit()', False),
    ]
    for name, body, expected in cases:
        source = "async def route(session, user):\n" + textwrap.indent(body, "    ")
        check("transactional audit inventory " + name,
              transactional_audit(source) == expected)

    from app.services import audit
    rows = []
    actor = SimpleNamespace(id="audit-actor", display_name="Audit actor", org_id="audit-org")
    row = audit.add(SimpleNamespace(add=rows.append), actor, "plugin.change",
                    "plugin", "audit-plugin", "Audit plugin", {"changed": True})
    check("transactional audit helper stages the actor, target and change without committing",
          rows == [row] and isinstance(row, models.AuditLog)
          and row.actor_id == actor.id and row.actor_name == actor.display_name
          and row.actor_org_id == actor.org_id and row.action == "plugin.change"
          and row.target_type == "plugin" and row.target_id == "audit-plugin"
          and row.detail == {"changed": True})


async def approval_audits(client, actor, headers):
    """Exercise delegated approval transactions and read their audits from a fresh session."""
    original = "user-security-ordinary"
    cases = [
        ("decision", "approve", {"decision": "approve"}),
        ("decision", "reject", {"decision": "reject"}),
        ("withdraw", "withdraw", {}),
        ("transfer", "transfer", {"fromUserId": original, "toUserId": actor}),
    ]
    verified = set()
    for route, action, body in cases:
        rid = "approval-" + action
        tid = "task-" + action
        vid = "version-" + action
        async with SessionLocal() as session:
            session.add_all([
                models.Task(id=tid, title=tid, created_by=actor, owner_user_id=actor),
                am.ArtifactVersion(id=vid, task_id=tid, kind="requirement", checksum="smoke",
                    manifest={"title": tid, "description": tid, "acceptanceCriteria": [tid]}),
                am.ApprovalRequest(id=rid, task_id=tid, artifact_version_id=vid, action="baseline",
                    policy_snapshot={"approvers": [{"type": "permission", "key": "release.approve"}]}),
                am.ApprovalAssignment(request_id=rid, user_id=original if route == "transfer" else actor),
            ])
            await session.commit()
        path = "/api/v1/admin/operations/approvals/{request_id}/" + route
        response = await client.post(path.format(request_id=rid), headers=headers, json={**body, "note": action})
        async with SessionLocal() as session:
            rows = (await session.scalars(select(models.AuditLog).where(
                models.AuditLog.target_type == "approval_request", models.AuditLog.target_id == rid))).all()
            audited = (response.status_code == 200 and len(rows) == 1
                       and rows[0].actor_id == actor and rows[0].action == "operations.approval_" + action
                       and rows[0].detail == {"taskId": tid, "versionId": vid, "requestId": rid,
                           "action": "baseline", "note": action,
                           **(body if route == "transfer" else {})})
        check(f"approval {action} commits one attributed audit for the selected request", audited, response.text)
        if audited:
            verified.add(("POST", path))
    return verified


async def batch_user_audits(client, actor, headers):
    path = "/api/v1/admin/users/batch"
    ids = ["batch-audit-a", "batch-audit-b"]
    targets = set(ids)
    async with SessionLocal() as session:
        session.add_all([models.User(id=uid, username=uid, is_active=True) for uid in ids])
        await session.commit()

    first_audit_ids = set()
    for expected_updates in (2, 0):
        response = await client.post(path, headers=headers, json={"ids": ids, "isActive": False})
        async with SessionLocal() as session:
            rows = (await session.scalars(select(models.AuditLog).where(
                models.AuditLog.target_id.in_(ids)))).all()
            disabled = set(await session.scalars(select(models.User.id).where(
                models.User.id.in_(ids), models.User.is_active.is_(False))))
        audit_ids = {row.id for row in rows}
        audited = (response.status_code == 200 and response.json() == {"updated": expected_updates}
                   and disabled == targets and len(rows) == len(ids)
                   and {row.target_id for row in rows} == targets
                   and all(row.actor_id == actor and row.action == "user.update" and row.target_type == "user"
                           and row.detail == {"fields": ["isActive"], "pwChanged": False} for row in rows)
                   and (not first_audit_ids or audit_ids == first_audit_ids))
        check(f"bulk update ({expected_updates} changed) preserves one audit per changed user", audited)
        if not audited:
            return set()
        first_audit_ids = audit_ids
    return {("POST", path)}


async def catalog_batch_audits(client, actor, headers):
    """Only credit routes whose HTTP mutations and per-target audits actually persist."""
    cases = (
        ("projects", models.Project, "", {"org_id": "org-security-a"}),
        ("repositories", models.Repo, "audit-projects-1", {"project_id": "audit-projects-1"}),
        ("orgs", models.OrgUnit, "", {}),
        ("professions", models.Position, "org-security-a", {"org_id": "org-security-a"}),
    )
    verified = set()
    for resource, model, scope_id, fields in cases:
        path = f"/api/v1/admin/business-records/{resource}"
        ids = [f"audit-{resource}-{suffix}" for suffix in (1, 2)]
        async with SessionLocal() as session:
            session.add_all([model(id=uid, name=uid, data_source="legacy", **fields) for uid in ids])
            await session.commit()

        before = {"dataSource": "legacy", "isArchived": False}
        passed_route = True
        for action, after in (
            ("test", {"dataSource": "test", "isArchived": False}),
            ("business", {"dataSource": "business", "isArchived": False}),
            ("archive", {"dataSource": "business", "isArchived": True}),
            ("restore", {"dataSource": "business", "isArchived": False}),
        ):
            audit_ids = set()
            body = {"ids": ids, "action": action, "scopeId": scope_id}
            for changed in (len(ids), 0):
                response = await client.post(path, headers=headers, json=body)
                async with SessionLocal() as session:
                    rows = (await session.scalars(select(model).where(model.id.in_(ids)))).all()
                    events = (await session.scalars(select(models.AuditLog).where(
                        models.AuditLog.target_id.in_(ids), models.AuditLog.action == "catalog." + action))).all()
                event_ids = {event.id for event in events}
                ok = (response.status_code == 200 and response.json() == {"changed": changed}
                      and {row.id for row in rows} == set(ids)
                      and all((row.data_source, row.is_archived) == (after["dataSource"], after["isArchived"])
                              for row in rows)
                      and len(events) == len(ids) and {event.target_id for event in events} == set(ids)
                      and all(event.actor_id == actor and event.target_type == model.__tablename__
                              and event.target_label == event.target_id
                              and event.detail == {"before": before, "after": after} for event in events)
                      and (changed > 0 or event_ids == audit_ids))
                check(f"{resource} {action} ({changed} changed) persists state and one audit per change", ok)
                passed_route = passed_route and ok
                audit_ids = event_ids
            before = after
        if passed_route:
            verified.add(("POST", path))
    return verified


def audit_contract(verified) -> None:
    missing = []
    seen_exemptions = set()
    mutation_count = 0
    for route in api_routes(app):
        methods = set(route.methods or ()) & MUTATIONS
        if not methods or not route.path.startswith("/api/v1/admin"):
            continue
        mutation_count += len(methods)
        source = inspect.getsource(route.endpoint)
        if (route.path == "/api/v1/admin/tasks/{tid}/ai-dispatch"
                and "from ..services.task_dispatch import dispatch" in source
                and "return await dispatch(tid, {}, owner, session, actor=user)" in source):
            # Shared dispatch owns the committed audit; the real HTTP actor
            # attribution is covered by test_admin_requirement_dispatch.py.
            from app.services import task_dispatch
            source += inspect.getsource(task_dispatch.dispatch)
        # Cloud-host state and its AuditLog commit together in the service,
        # rather than through the route-level audit.log helper. Follow these
        # exact delegates; they are persistent writes, never audit exemptions.
        cloud_audit = False
        if route.endpoint.__module__ == "app.api.admin_cloud_runners":
            from app.services import cloud_runner_admin
            delegate = {"availability": "availability", "reassign": "transfer",
                        "provision": "provision"}.get(route.endpoint.__name__)
            if delegate and f"return await service.{delegate}(session, user," in source:
                body = inspect.getsource(getattr(cloud_runner_admin, delegate))
                writer = inspect.getsource(cloud_runner_admin._audit)
                audit_at = body.find("\n    _audit(session, actor, row,")
                commit_at = body.rfind("await session.commit()")
                cloud_audit = (0 <= audit_at < commit_at
                    and "session.add(AuditLog(" in writer
                    and "actor_id=actor.id" in writer
                    and "action=action" in writer and "target_id=row.id" in writer)
        quota_audit = False
        if route.endpoint.__module__ == "app.api.quotas":
            from app.api import quotas
            writer = inspect.getsource(quotas.record)
            audit_at = source.find("\n    record(session, user,")
            commit_at = source.rfind("await session.commit()")
            quota_audit = (0 <= audit_at < commit_at
                           and "session.add(AuditLog(" in writer
                           and "actor_id=actor.id" in writer
                           and 'detail={"before": before, "after": after}' in writer)
        legal_audit = False
        if route.endpoint.__module__ == "app.api.legal_documents":
            from app.services import legal_publications
            delegate = route.endpoint.__name__
            body = source if delegate == "draft" else inspect.getsource(getattr(legal_publications, delegate))
            writer = inspect.getsource(legal_publications.audit_event)
            call = "legal.audit_event(" if delegate == "draft" else "audit_event("
            service_at = source.find("await legal." + ("save_draft" if delegate == "draft" else delegate) + "(")
            commit_at = source.rfind("await session.commit()")
            legal_audit = (0 <= service_at < commit_at and call in body
                           and "session.add(AuditLog(" in writer and "actor_id=actor.id" in writer
                           and "action=action" in writer and "target_id=target" in writer)
        if ("audit.log(" in source or transactional_audit(source)
                or cloud_audit or quota_audit or legal_audit):
            continue
        for method in methods:
            key = (method, route.path)
            if key in verified:
                continue
            if key in AUDIT_EXEMPT:
                seen_exemptions.add(key)
            else:
                missing.append(key)
    check("audit inventory covers the complete management mutation graph",
          mutation_count >= 139, mutation_count)
    check("every persistent management mutation records an audit event",
          not missing, missing)
    stale = set(AUDIT_EXEMPT) - seen_exemptions
    check("audit exceptions are explicit, present, and still non-persistent",
          not stale, sorted(stale))


async def main() -> None:
    permission_contract()
    transactional_audit_contract()
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with SessionLocal() as session:
        org_a = models.OrgUnit(id="org-security-a", name="研发中心")
        org_a_child = models.OrgUnit(
            id="org-security-a-child", name="开发组", parent_id=org_a.id)
        org_b = models.OrgUnit(id="org-security-b", name="外地事业部")
        manager_role = models.Role(
            id="role-security-org-manager", name="部门组织管理员",
            permissions=["org.manage", "binding.manage",
                         "integration.manage"])
        manager = models.User(
            id="user-security-manager", username="security-manager",
            display_name="研发组织管理员", org_id=org_a.id,
            role_id=manager_role.id, is_active=True, auth_version=1)
        ordinary = models.User(
            id="user-security-ordinary", username="security-ordinary",
            display_name="普通员工", org_id=org_a_child.id,
            is_active=True, auth_version=1)
        outsider = models.User(
            id="user-security-outsider", username="security-outsider",
            display_name="外地员工", org_id=org_b.id,
            is_active=True, auth_version=1)
        super_user = models.User(
            id="user-security-super", username="security-super",
            display_name="超级管理员", is_super=True,
            is_active=True, auth_version=1)
        client_a = models.Client(
            id="client-security-a", name="研发 SoduWork", user_ref=ordinary.id,
            auth_state="active")
        client_b = models.Client(
            id="client-security-b", name="外地 SoduWork", user_ref=outsider.id,
            auth_state="active")
        integration = models.Integration(
            id="integration-security", name="安全测试源", type="generic", enabled=True)
        sibling_binding = models.IntegrationBinding(
            id="binding-security-sibling", integration_id=integration.id,
            external_actor="outside-actor", client_id=client_b.id)
        assignable = models.Task(
            id="task-security-assignable", title="待安全分配任务", origin="generic",
            integration_id=integration.id, external_actor="inside-actor")
        sibling_pool = models.Task(
            id="task-security-sibling-pool", title="外地团队任务", origin="generic",
            pool_org_id=org_b.id)
        session.add_all([
            org_a, org_a_child, org_b, manager_role, manager, ordinary, outsider,
            super_user, client_a, client_b, integration, sibling_binding,
            assignable, sibling_pool,
        ])
        await session.commit()

    manager_headers = {
        "Authorization": "Bearer " + sign_token("user-security-manager", 1)}
    ordinary_headers = {
        "Authorization": "Bearer " + sign_token("user-security-ordinary", 1)}
    super_headers = {
        "Authorization": "Bearer " + sign_token("user-security-super", 1)}
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://soduwork.test"
    ) as client:
        await admin_cache_contract(client, super_headers)
        verified = await approval_audits(client, super_user.id, super_headers)
        verified.update(await batch_user_audits(client, super_user.id, super_headers))
        denied = await client.post(
            "/api/v1/admin/orgs", headers=ordinary_headers,
            json={"name": "越权新部门", "parentId": "org-security-a"})
        check("a user without org.manage cannot write the tree",
              denied.status_code == 403, denied.text)

        created = await client.post(
            "/api/v1/admin/orgs", headers=manager_headers,
            json={"name": "平台组", "parentId": "org-security-a", "sort": 3})
        created_body = created.json() if created.status_code == 200 else {}
        leaf_id = str(created_body.get("id") or "")
        check("department manager can create below the managed subtree",
              created.status_code == 200 and leaf_id, created.text)

        cross_create = await client.post(
            "/api/v1/admin/orgs", headers=manager_headers,
            json={"name": "越权部门", "parentId": "org-security-b"})
        check("department manager cannot create under a sibling tree",
              cross_create.status_code == 403, cross_create.text)

        root_create = await client.post(
            "/api/v1/admin/orgs", headers=manager_headers,
            json={"name": "伪造根部门", "parentId": ""})
        check("only a super administrator may create a root department",
              root_create.status_code == 403, root_create.text)

        cross_update = await client.patch(
            "/api/v1/admin/orgs/org-security-b", headers=manager_headers,
            json={"name": "被越权改名"})
        check("department manager cannot modify a sibling tree",
              cross_update.status_code == 403, cross_update.text)

        cycle = await client.patch(
            "/api/v1/admin/orgs/org-security-a", headers=manager_headers,
            json={"parentId": leaf_id})
        check("department tree rejects parent-child cycles",
              cycle.status_code == 400 and "下级" in cycle.text, cycle.text)

        promote = await client.patch(
            f"/api/v1/admin/orgs/{leaf_id}", headers=manager_headers,
            json={"parentId": ""})
        check("department manager cannot promote a node outside the subtree",
              promote.status_code == 403, promote.text)

        renamed = await client.patch(
            f"/api/v1/admin/orgs/{leaf_id}", headers=manager_headers,
            json={"name": "平台工程组", "sort": 4})
        check("authorized in-scope update still works",
              renamed.status_code == 200
              and renamed.json().get("name") == "平台工程组", renamed.text)

        removed = await client.delete(
            f"/api/v1/admin/orgs/{leaf_id}", headers=manager_headers)
        check("authorized in-scope leaf deletion still works",
              removed.status_code == 200 and removed.json().get("ok") is True,
              removed.text)

        cross_delete = await client.delete(
            "/api/v1/admin/orgs/org-security-b", headers=manager_headers)
        check("department manager cannot delete a sibling tree",
              cross_delete.status_code == 403, cross_delete.text)

        super_root = await client.post(
            "/api/v1/admin/orgs", headers=super_headers,
            json={"name": "新企业根", "parentId": ""})
        check("super administrator retains root governance",
              super_root.status_code == 200
              and super_root.json().get("parentId") is None, super_root.text)

        created_integration = await client.post(
            "/api/v1/admin/integrations", headers=manager_headers,
            json={"name": "一次性令牌源", "type": "generic", "config": {}})
        created_integration_body = (
            created_integration.json() if created_integration.status_code == 200 else {})
        created_integration_id = str(created_integration_body.get("id") or "")
        first_token = str(created_integration_body.get("ingestToken") or "")
        check("integration token is revealed once at creation",
              created_integration.status_code == 200 and created_integration_id
              and first_token.startswith("ingest_")
              and created_integration_body.get("ingestTokenSet") is True,
              created_integration.text)

        listed_integrations = await client.get(
            "/api/v1/admin/integrations", headers=manager_headers)
        listed_row = next((row for row in listed_integrations.json()
                           if row.get("id") == created_integration_id), {})
        check("integration lists report credential presence without plaintext",
              listed_integrations.status_code == 200
              and listed_row.get("ingestTokenSet") is True
              and "ingestToken" not in listed_row
              and first_token not in listed_integrations.text, listed_row)

        updated_integration = await client.patch(
            f"/api/v1/admin/integrations/{created_integration_id}",
            headers=manager_headers, json={"config": {"mcpKey": "mcp-private-value"}})
        updated_body = updated_integration.json() if updated_integration.status_code == 200 else {}
        check("integration updates mask config secrets and never echo the ingest token",
              updated_integration.status_code == 200
              and updated_body.get("config", {}).get("mcpKey") == "***"
              and "ingestToken" not in updated_body, updated_integration.text)

        rotated = await client.post(
            f"/api/v1/admin/integrations/{created_integration_id}/token/rotate",
            headers=manager_headers, json={})
        rotated_body = rotated.json() if rotated.status_code == 200 else {}
        rotated_token = str(rotated_body.get("ingestToken") or "")
        listed_after_rotate = await client.get(
            "/api/v1/admin/integrations", headers=manager_headers)
        check("token rotation invalidates the old secret and reveals the replacement once",
              rotated.status_code == 200 and rotated_token.startswith("ingest_")
              and rotated_token != first_token and first_token not in listed_after_rotate.text
              and rotated_token not in listed_after_rotate.text, rotated.text)

        own_binding = await client.post(
            "/api/v1/admin/bindings", headers=manager_headers,
            json={"integration_id": "integration-security",
                  "external_actor": "inside-actor",
                  "client_id": "client-security-a"})
        own_binding_body = own_binding.json() if own_binding.status_code == 200 else {}
        own_binding_id = str(own_binding_body.get("id") or "")
        check("department manager can bind an external actor to an in-scope SoduWork",
              own_binding.status_code == 200 and own_binding_id, own_binding.text)

        cross_binding = await client.post(
            "/api/v1/admin/bindings", headers=manager_headers,
            json={"integration_id": "integration-security",
                  "external_actor": "cross-created",
                  "client_id": "client-security-b"})
        check("department manager cannot bind an actor to a sibling SoduWork",
              cross_binding.status_code == 403, cross_binding.text)

        cross_binding_delete = await client.delete(
            "/api/v1/admin/bindings/binding-security-sibling",
            headers=manager_headers)
        check("department manager cannot delete a sibling SoduWork binding",
              cross_binding_delete.status_code == 403, cross_binding_delete.text)

        cross_assign = await client.post(
            "/api/v1/admin/unassigned/task-security-assignable/assign",
            headers=manager_headers,
            json={"client_id": "client-security-b", "create_binding": False})
        check("department manager cannot assign work to a sibling SoduWork",
              cross_assign.status_code == 403, cross_assign.text)

        cross_pool = await client.post(
            "/api/v1/admin/unassigned/task-security-sibling-pool/assign",
            headers=manager_headers,
            json={"client_id": "client-security-a", "create_binding": False})
        check("department manager cannot take a sibling department inbox task",
              cross_pool.status_code == 403, cross_pool.text)

        visible_bindings = await client.get(
            "/api/v1/admin/bindings", headers=manager_headers)
        binding_ids = {row.get("id") for row in visible_bindings.json()}
        check("binding list filters sibling departments instead of failing the page",
              visible_bindings.status_code == 200 and own_binding_id in binding_ids
              and "binding-security-sibling" not in binding_ids, binding_ids)

        visible_unassigned = await client.get(
            "/api/v1/admin/unassigned", headers=manager_headers)
        unassigned_ids = {row.get("id") for row in visible_unassigned.json()}
        check("unassigned list hides sibling department inbox tasks",
              visible_unassigned.status_code == 200
              and "task-security-assignable" in unassigned_ids
              and "task-security-sibling-pool" not in unassigned_ids, unassigned_ids)

        own_assign = await client.post(
            "/api/v1/admin/unassigned/task-security-assignable/assign",
            headers=manager_headers,
            json={"client_id": "client-security-a", "create_binding": False})
        check("department manager can assign global unassigned work in-scope",
              own_assign.status_code == 200
              and own_assign.json().get("task", {}).get("ownerClientId") == "client-security-a",
              own_assign.text)

        own_delete = await client.delete(
            f"/api/v1/admin/bindings/{own_binding_id}", headers=manager_headers)
        check("department manager can delete an in-scope binding",
              own_delete.status_code == 200 and own_delete.json().get("ok") is True,
              own_delete.text)

    async with SessionLocal() as session:
        sibling = await session.get(models.OrgUnit, "org-security-b")
        root = await session.get(models.OrgUnit, "org-security-a")
        leaf = await session.get(models.OrgUnit, leaf_id)
        total = await session.scalar(
            select(func.count()).select_from(models.OrgUnit))
        logs = list((await session.execute(
            select(models.AuditLog).where(
                models.AuditLog.actor_id == "user-security-manager")
            .order_by(models.AuditLog.at)
        )).scalars().all())
        sibling_binding = await session.get(
            models.IntegrationBinding, "binding-security-sibling")
        leaked_binding = await session.scalar(
            select(func.count()).select_from(models.IntegrationBinding).where(
                models.IntegrationBinding.external_actor == "cross-created"))
        assigned_task = await session.get(models.Task, "task-security-assignable")
        sibling_pool_task = await session.get(
            models.Task, "task-security-sibling-pool")
        check("denied writes leave sibling and tree structure unchanged",
              sibling is not None and sibling.name == "外地事业部"
              and root is not None and root.parent_id is None and leaf is None
              and total == 4,
              {"sibling": getattr(sibling, "name", None),
               "rootParent": getattr(root, "parent_id", None),
               "leaf": bool(leaf), "total": total})
        check("denied binding and assignment writes leave no partial state",
              sibling_binding is not None and leaked_binding == 0
              and assigned_task.owner_client_id == "client-security-a"
              and sibling_pool_task.owner_client_id is None,
              {"siblingBinding": bool(sibling_binding), "leaked": leaked_binding,
               "assigned": assigned_task.owner_client_id,
               "siblingPool": sibling_pool_task.owner_client_id})
        token_row = await session.get(models.Integration, created_integration_id)
        check("only the rotated integration token remains authoritative",
              token_row is not None and token_row.ingest_token == rotated_token
              and token_row.ingest_token != first_token,
              getattr(token_row, "ingest_token", None))
        audit_blob = json.dumps([row.detail or {} for row in logs], ensure_ascii=False)
        check("audit details never retain credential plaintext",
              first_token not in audit_blob and rotated_token not in audit_blob
              and "mcp-private-value" not in audit_blob, audit_blob)
        actions = [row.action for row in logs]
        check("successful management writes produce a complete audit trail",
              [action for action in actions if action.startswith("org.")] == [
                  "org.create", "org.update", "org.delete"]
              and all(action in actions for action in (
                  "binding.upsert", "task.assign", "binding.delete", "integration.create",
                  "integration.update", "integration.token.rotate")), actions)


    async with httpx.AsyncClient(transport=transport, base_url="http://soduwork.test") as client:
        verified.update(await catalog_batch_audits(client, super_user.id, super_headers))
    audit_contract(verified)


async def run() -> None:
    try:
        await main()
    finally:
        await engine.dispose()


try:
    asyncio.run(run())
finally:
    _tmp.cleanup()

print(f"\nadmin security: {passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
