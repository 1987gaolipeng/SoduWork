"""Organization, role, and user management with RBAC subtree scope. Super administrators see all;
other users are scoped to their organization subtree. Clients inherit organization through
user_ref.
"""
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import String, func, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..auth import hash_password
from ..config import get_settings
from ..pagination import Page, list_result, select_rows
from ..permissions import ALL_KEYS, valid_keys
from ..schemas import AdminName, _ms
from . import catalog_names, client_access
from .business_records import business_visible, creation_source, record_fields

_DEPT_ADMIN_PERMS = [
    "client.view", "client.assign", "client.control", "client.update",
    "task.view", "task.dispatch", "user.manage", "work.catalog.manage",
]

_BUILTIN_ROLE_PERMISSIONS_VERSION = "rbac_builtin_role_permissions_v4"


class OrgMutationError(ValueError):
    """A department-tree write crossed its authorized boundary or broke the tree."""

    def __init__(self, reason: str):
        self.reason = str(reason or "invalid")
        super().__init__(self.reason)


# Serialization.

def org_to_api(o: models.OrgUnit) -> dict:
    return {"id": o.id, "name": o.name, "parentId": o.parent_id, "sort": o.sort,
            "createdAt": _ms(o.created_at), **record_fields(o)}


def role_to_api(r: models.Role) -> dict:
    return {"id": r.id, "name": r.name, "permissions": list(r.permissions or []), "isSystem": r.is_system}


def user_to_api(u: models.User, *, token_quota=None) -> dict:
    result = {
        "id": u.id, "username": u.username, "displayName": u.display_name,
        "orgId": u.org_id, "roleId": u.role_id, "isSuper": u.is_super, "isActive": u.is_active,
        "positions": list(getattr(u, "positions", None) or []),
        "domains": list(getattr(u, "domains", None) or []),
        "lastLogin": _ms(u.last_login_at), "createdAt": _ms(u.created_at),
    }
    if token_quota is not None:
        result["tokenQuota"] = token_quota
        result["isTestAccount"] = u.is_test_account
    return result


def position_to_api(p: models.Position) -> dict:
    from .work_catalog import profession_api
    return profession_api(p)


def domain_to_api(d: models.Domain) -> dict:
    return {"id": d.id, "name": d.name, "sort": d.sort, "isSystem": d.is_system}


def _validate_org_name(name: str) -> str:
    """Validate and normalize an organization/department name."""
    name = str(name).strip()
    if not name:
        return "未命名部门"
    if len(name) > 200:
        name = name[:200]
    return name


# Authorization scope.

async def subtree_org_ids(session: AsyncSession, root_id: str, *, parents=None) -> set[str]:
    """Return root_id and every descendant organization ID."""
    if parents is None:
        res = await session.execute(select(models.OrgUnit.id, models.OrgUnit.parent_id))
        parents = dict(res.all())
    children: dict[str, list[str]] = {}
    for oid, pid in parents.items():
        children.setdefault(pid, []).append(oid)
    out, stack = set(), [root_id]
    while stack:
        cur = stack.pop()
        if cur in out:
            continue
        out.add(cur)
        stack.extend(children.get(cur, []))
    return out


async def ancestor_org_ids(session: AsyncSession, leaf_id: str) -> set[str]:
    """Return leaf_id and every parent organization up to the root.

    Employee-facing enterprise capabilities are inherited from parent
    organizations. Keeping this traversal beside subtree_org_ids gives
    catalogs, conversation grants and connector authorization one definition
    of that boundary.
    """
    if not leaf_id:
        return set()
    res = await session.execute(select(models.OrgUnit.id, models.OrgUnit.parent_id))
    parents = {str(oid): (str(pid) if pid else "") for oid, pid in res.all()}
    out: set[str] = set()
    current = str(leaf_id)
    while current and current not in out:
        out.add(current)
        current = parents.get(current, "")
    return out


async def scope_org_ids(session: AsyncSession, user: models.User) -> set[str] | None:
    """Return None for super-administrator scope, otherwise the user's organization subtree or an
    empty set when unbound.
    """
    if user.is_super:
        return None
    if not user.org_id:
        return set()
    return await subtree_org_ids(session, user.org_id)


async def company_org_ids(session: AsyncSession, user: models.User | None, *, parents=None) -> set[str] | None:
    """Full organization tree under the user's company root.

    Management scope answers who the user can administer. Company scope answers
    which shared records the user may read. Keeping them separate prevents a
    company-wide catalog from accidentally granting company-wide write access.
    None means an unrestricted super administrator.
    """
    if user and user.is_super:
        return None
    if not (user and user.is_active and user.org_id):
        return set()
    if parents is None:
        rows = (await session.execute(
            select(models.OrgUnit.id, models.OrgUnit.parent_id)
        )).all()
        parents = {str(oid): (str(pid) if pid else "") for oid, pid in rows}
    return await company_org_ids_for_org(session, user.org_id, parents=parents)


async def company_org_ids_for_org(session: AsyncSession, org_id: str | None, *, parents=None) -> set[str]:
    """Return the complete company tree containing ``org_id``.

    This is the read/visibility boundary for company-wide capabilities. It is
    intentionally separate from ``scope_org_ids``: management remains scoped
    to an administrator's subtree, while a policy explicitly granted to all
    company members must reach sibling departments as well.
    """
    if not org_id:
        return set()
    if parents is None:
        rows = (await session.execute(
            select(models.OrgUnit.id, models.OrgUnit.parent_id)
        )).all()
        parents = {str(oid): (str(pid) if pid else "") for oid, pid in rows}
    current = str(org_id)
    if current not in parents:
        return set()
    seen: set[str] = set()
    while current and current not in seen:
        seen.add(current)
        parent = parents.get(current, "")
        if not parent:
            break
        current = parent
    return await subtree_org_ids(session, current, parents=parents)


async def scoped_user_ids(session: AsyncSession, scope: set[str] | None) -> set[str] | None:
    """Return user IDs within scope, or None for unrestricted access."""
    if scope is None:
        return None
    if not scope:
        return set()
    res = await session.execute(select(models.User.id).where(models.User.org_id.in_(scope)))
    return {r[0] for r in res.all()}


# Organization structure.

_admin_name = TypeAdapter(AdminName)


async def lock_org_tree(session: AsyncSession, *, shared: bool = False) -> None:
    """Keep subtree scope and user assignments consistent with department edits."""
    if session.get_bind().dialect.name == "postgresql":
        await session.execute(text("LOCK TABLE org_unit IN SHARE MODE" if shared else
                                   "LOCK TABLE org_unit IN SHARE ROW EXCLUSIVE MODE"))
    else:
        # Reserve the SQLite writer without changing any existing row.
        await session.execute(update(models.OrgUnit).where(False).values(sort=models.OrgUnit.sort))


async def _available_org_name(session: AsyncSession, name: str, parent_id: str | None,
                              exclude_id: str | None = None) -> str:
    try:
        name = _admin_name.validate_python(name)
    except ValidationError as exc:
        # Moving a legacy node can supply its stored name instead of an API field.
        raise OrgMutationError("invalid_name") from exc
    query = select(models.OrgUnit.name).where(models.OrgUnit.parent_id == parent_id)
    if exclude_id is not None:
        query = query.where(models.OrgUnit.id != exclude_id)
    # Older names may have Unicode whitespace that SQL trim() doesn't remove.
    if any(sibling.strip() == name for sibling in await session.scalars(query)):
        raise OrgMutationError("duplicate_name")
    return name


async def list_orgs(session: AsyncSession, scope: set[str] | None, *, page: Page | None = None,
                    include_managed: bool = False):
    q = select(models.OrgUnit).order_by(models.OrgUnit.sort, models.OrgUnit.created_at, models.OrgUnit.id)
    if not include_managed:
        q = q.where(business_visible(models.OrgUnit))
    if scope is not None:
        q = q.where(models.OrgUnit.id.in_(scope))
    rows, total = await select_rows(session, q, page)
    return list_result([org_to_api(o) for o in rows], total)


async def create_org(
    session: AsyncSession, name: str, parent_id: str | None, sort: int = 0,
    *, actor: models.User, data_source: str | None = None,
) -> dict:
    """Stage a department below an authorized parent; only super users may create a root."""
    name = _validate_org_name(name) if name else "未命名部门"
    pid = str(parent_id or "").strip() or None
    await lock_org_tree(session)
    scope = await scope_org_ids(session, actor)
    if scope is not None and (not pid or pid not in scope):
        raise OrgMutationError("out_of_scope")
    parent = await session.get(models.OrgUnit, pid, populate_existing=True) if pid else None
    if pid and parent is None:
        raise OrgMutationError("parent_not_found")
    if parent and parent.is_archived:
        raise OrgMutationError("archived_parent")
    o = models.OrgUnit(name=await _available_org_name(session, name, pid), parent_id=pid, sort=sort,
                       data_source=creation_source(actor, data_source, parent))
    session.add(o)
    await session.flush()
    await session.refresh(o)
    return org_to_api(o)


async def update_org(
    session: AsyncSession, oid: str, name: str | None,
    parent_id: str | None, sort: int | None, *, actor: models.User,
) -> dict | None:
    """Update only an authorized node and keep the department tree acyclic."""
    await lock_org_tree(session)
    o = await session.get(models.OrgUnit, oid, populate_existing=True)
    if o is None:
        return None
    scope = await scope_org_ids(session, actor)
    if scope is not None and oid not in scope:
        raise OrgMutationError("out_of_scope")
    if o.is_archived:
        raise OrgMutationError("archived_org")
    pid = o.parent_id
    normalized_name = _validate_org_name(name) if name is not None else o.name
    if parent_id is not None:
        pid = str(parent_id or "").strip() or None
        if scope is not None and (not pid or pid not in scope):
            raise OrgMutationError("out_of_scope")
        if pid:
            parent = await session.get(models.OrgUnit, pid, populate_existing=True)
            if parent is None:
                raise OrgMutationError("parent_not_found")
            if parent.is_archived and parent.id != o.parent_id:
                raise OrgMutationError("archived_parent")
            if pid == oid or pid in await subtree_org_ids(session, oid):
                raise OrgMutationError("cycle")
    if pid != o.parent_id or normalized_name != o.name:
        o.name = await _available_org_name(session, normalized_name, pid, oid)
        o.parent_id = pid
    if sort is not None:
        o.sort = sort
    await session.commit()
    await session.refresh(o)
    return org_to_api(o)


async def delete_org(
    session: AsyncSession, oid: str, *, actor: models.User,
) -> dict:
    await lock_org_tree(session)
    o = await session.get(models.OrgUnit, oid, populate_existing=True)
    if o is None:
        return {"ok": False, "reason": "not_found"}
    scope = await scope_org_ids(session, actor)
    if scope is not None and oid not in scope:
        raise OrgMutationError("out_of_scope")
    # The delete is physical (repo convention: no soft-delete column), so every soft
    # org reference (no foreign keys) must block first. Return counts so callers can
    # show actionable messages; success also carries parent/sort so an accidental
    # delete can be reconstructed from the audit entry.
    child = await session.scalar(select(func.count()).select_from(models.OrgUnit).where(models.OrgUnit.parent_id == oid))
    if child:
        return {"ok": False, "reason": "has_children", "count": int(child)}
    users = await session.scalar(select(func.count()).select_from(models.User).where(models.User.org_id == oid))
    if users:
        return {"ok": False, "reason": "has_users", "count": int(users)}
    positions = await session.scalar(select(func.count()).select_from(models.Position).where(models.Position.org_id == oid))
    if positions:
        return {"ok": False, "reason": "has_positions", "count": int(positions)}
    scenarios = await session.scalar(select(func.count()).select_from(models.WorkScenario).where(models.WorkScenario.org_id == oid))
    if scenarios:
        return {"ok": False, "reason": "has_scenarios", "count": int(scenarios)}
    projects = await session.scalar(select(func.count()).select_from(models.Project).where(models.Project.org_id == oid))
    if projects:
        return {"ok": False, "reason": "has_projects", "count": int(projects)}
    repos = await session.scalar(select(func.count()).select_from(models.Repo).where(models.Repo.org_id == oid))
    if repos:
        return {"ok": False, "reason": "has_repos", "count": int(repos)}
    default_orgs = await session.scalar(
        select(func.count()).select_from(models.IdentityProvider).where(models.IdentityProvider.default_org_id == oid))
    if default_orgs:
        return {"ok": False, "reason": "has_default_org", "count": int(default_orgs)}
    deleted = {"id": o.id, "name": o.name, "parent_id": o.parent_id, "sort": o.sort}
    await session.delete(o)
    await session.commit()
    return {"ok": True, **deleted}


# Roles.

async def list_roles(session: AsyncSession, *, page: Page | None = None):
    q = select(models.Role).order_by(models.Role.created_at, models.Role.id)
    rows, total = await select_rows(session, q, page)
    return list_result([role_to_api(r) for r in rows], total)


async def create_role(session: AsyncSession, name: str, permissions: list[str]) -> dict:
    unknown = sorted(set(str(key) for key in (permissions or [])) - set(ALL_KEYS))
    if unknown:
        raise ValueError("未知权限：" + ", ".join(unknown))
    name = _admin_name.validate_python(name)
    await catalog_names.require_available(session, models.Role, name, "角色名已存在")
    r = models.Role(name=name, permissions=valid_keys(permissions))
    session.add(r)
    await session.commit()
    await session.refresh(r)
    return role_to_api(r)


async def update_role(session: AsyncSession, rid: str, name: str | None, permissions: list[str] | None) -> dict | None:
    r = await session.get(models.Role, rid)
    if r is None:
        return None
    if r.is_system:
        raise ValueError("系统内置角色不允许修改")
    if name is not None:
        name = _admin_name.validate_python(name)
        if name != r.name:
            await catalog_names.require_available(session, models.Role, name, "角色名已存在", exclude_id=rid)
        r.name = name
    if permissions is not None:
        unknown = sorted(set(str(key) for key in permissions) - set(ALL_KEYS))
        if unknown:
            raise ValueError("未知权限：" + ", ".join(unknown))
        r.permissions = valid_keys(permissions)
    await session.commit()
    await session.refresh(r)
    return role_to_api(r)


async def lock_role_reference(session: AsyncSession, rid: str):
    # A concurrent role deletion must observe the new assignment or complete first.
    if session.get_bind().dialect.name == "sqlite":
        await session.execute(update(models.Role).where(models.Role.id == rid).values(id=models.Role.id))
    return await session.get(models.Role, rid, with_for_update=True, populate_existing=True)


async def delete_role(session: AsyncSession, rid: str) -> dict:
    r = await lock_role_reference(session, rid)
    if r is None:
        return {"ok": False, "reason": "not_found"}
    if r.is_system:
        return {"ok": False, "reason": "system_role"}
    inuse = await session.scalar(select(func.count()).select_from(models.User).where(models.User.role_id == rid))
    if inuse:
        return {"ok": False, "reason": "in_use"}
    await session.delete(r)
    await session.commit()
    return {"ok": True}


# Users.

async def list_users(session: AsyncSession, scope: set[str] | None, *, page: Page | None = None, is_active: bool | None = None):
    q = select(models.User).order_by(models.User.created_at, models.User.id)
    if is_active is not None:
        q = q.where(models.User.is_active.is_(is_active))
    if scope is not None:
        q = q.where(models.User.org_id.in_(scope or {"__none__"}))
    users, total = await select_rows(session, q, page)
    # Merged view (issue #935): an effective assignment wins admission and the
    # quota page, so user lists must show the same numbers instead of the legacy
    # override alone. Entries carry quotaSource so callers can label the origin.
    quotas = await client_access.effective_quotas(session, [u.id for u in users])
    items = [user_to_api(u, token_quota=quotas.get(u.id, {"mode": "inherit", "limit": 0})) for u in users]
    return list_result(items, total)


async def get_user_by_username(session: AsyncSession, username: str) -> models.User | None:
    res = await session.execute(select(models.User).where(models.User.username == username))
    return res.scalar_one_or_none()


async def create_user(session: AsyncSession, username: str, password: str, display_name: str,
                      org_id: str | None, role_id: str | None, positions: list | None = None,
                      domains: list | None = None, *, token_quota=None, is_test_account: bool | None = None) -> dict:
    password = client_access.validate_password(password, new_account=True)
    u = models.User(
        username=username, password_hash=hash_password(password),
        is_test_account=is_test_account,
        display_name=display_name or username, org_id=org_id or None, role_id=role_id or None,
        positions=list(positions or []), domains=list(domains or []),
    )
    session.add(u)
    if token_quota is not None:
        await session.flush()
        token_quota = await client_access.save_user_quota(session, u.id, token_quota)
    await session.commit()
    await session.refresh(u)
    return user_to_api(u, token_quota=token_quota or {"mode": "inherit", "limit": 0})


def apply_user_patch(u: models.User, patch: dict) -> None:
    password = patch.get("password")
    if password is not None:
        password = client_access.validate_password(password, new_account=True)
    if "displayName" in patch and patch["displayName"] is not None:
        u.display_name = patch["displayName"]
    if "isTestAccount" in patch:
        u.is_test_account = patch["isTestAccount"]
    if "orgId" in patch and patch["orgId"] is not None:
        u.org_id = patch["orgId"] or None
    if "roleId" in patch:
        u.role_id = patch["roleId"] or None
    revoke_sessions = False
    if "isActive" in patch and patch["isActive"] is not None:
        active = bool(patch["isActive"])
        revoke_sessions = revoke_sessions or active != bool(u.is_active)
        u.is_active = active
    if patch.get("positions") is not None:
        u.positions = list(patch["positions"] or [])
    if patch.get("domains") is not None:
        u.domains = list(patch["domains"] or [])
    if password is not None:
        u.password_hash = hash_password(password)
        revoke_sessions = True
    if revoke_sessions:
        u.auth_version = int(u.auth_version or 0) + 1


async def update_user(session: AsyncSession, uid: str, patch: dict) -> dict | None:
    u = await session.get(models.User, uid)
    if u is None:
        return None
    apply_user_patch(u, patch)
    if patch.get("tokenQuota") is not None:
        await client_access.save_user_quota(session, uid, patch["tokenQuota"])
    # The stored override never applies while an effective assignment exists
    # (admission reads the assignment). Surface the effective numbers instead
    # of silently acknowledging a patch that admission ignores.
    quota = (await client_access.effective_quotas(session, [uid])).get(uid)
    if quota is None or quota.get("quotaSource") != "assignment":
        quota = (await client_access.user_quotas(session, [uid])).get(uid)
    await session.commit()
    await session.refresh(u)
    return user_to_api(u, token_quota=quota or {"mode": "inherit", "limit": 0})


# Professional positions.

# Stable built-in position IDs such as p_dev, p_qa, and p_ops support default workflow references.
SEED_POSITIONS = [("p_dev", "开发", 1), ("p_qa", "测试", 2), ("p_ops", "运维", 3),
                  ("p_pm", "产品", 4), ("p_design", "设计", 5)]


async def seed_positions(session: AsyncSession) -> None:
    """Idempotently seed default positions on initial setup."""
    changed = False
    for pid, name, sort in SEED_POSITIONS:
        if await session.get(models.Position, pid) is None:
            session.add(models.Position(id=pid, name=name, sort=sort, is_system=True, data_source="business"))
            changed = True
    if changed:
        await session.commit()


async def list_positions(
    session: AsyncSession, org_ids: set[str] | None = None
) -> list[dict]:
    """List professional profiles within the supplied scope; org_ids=None is reserved for super
    administrators.
    """
    from .work_catalog import assignable_professions
    query = assignable_professions()
    if org_ids is not None:
        query = query.where(or_(
            models.Position.org_id.is_(None),
            models.Position.org_id.in_(org_ids or {"__none__"}),
        ))
    res = await session.execute(query.order_by(
        models.Position.sort, models.Position.created_at))
    return [position_to_api(p) for p in res.scalars().all()]


async def create_position(session: AsyncSession, name: str, sort: int = 0) -> dict:
    from uuid import uuid4
    p = models.Position(id="pos_" + uuid4().hex[:10], name=name or "未命名岗位", sort=sort)
    session.add(p)
    await session.commit()
    await session.refresh(p)
    return position_to_api(p)


async def update_position(session: AsyncSession, pid: str, name: str | None, sort: int | None) -> dict | None:
    p = await session.get(models.Position, pid)
    if p is None:
        return None
    if name is not None:
        p.name = name
    if sort is not None:
        p.sort = sort
    await session.commit()
    await session.refresh(p)
    return position_to_api(p)


async def delete_position(session: AsyncSession, pid: str) -> dict:
    p = await session.get(models.Position, pid)
    if p is None:
        return {"ok": False, "reason": "not_found"}
    if p.is_system:
        return {"ok": False, "reason": "system"}
    await session.delete(p)
    await session.commit()
    return {"ok": True}


# Responsibility domains, modules, and skills.

# Seed editable, removable example domains only during initial setup; user deletion must not recreate them.
SEED_DOMAINS = [("前端界面", 1), ("后端服务", 2), ("数据/报表", 3),
                ("移动端", 4), ("算法/模型", 5), ("基础设施/运维", 6)]


async def seed_domains(session: AsyncSession) -> None:
    """Seed example domains once when initially empty, without restoring entries users later
    remove.
    """
    from uuid import uuid4
    n = await session.scalar(select(func.count()).select_from(models.Domain))
    if n and n > 0:
        return
    for name, sort in SEED_DOMAINS:
        session.add(models.Domain(id="dom_" + uuid4().hex[:10], name=name, sort=sort, is_system=False))
    await session.commit()


async def list_domains(session: AsyncSession, *, page: Page | None = None):
    q = select(models.Domain).order_by(models.Domain.sort, models.Domain.created_at, models.Domain.id)
    rows, total = await select_rows(session, q, page)
    return list_result([domain_to_api(d) for d in rows], total)


async def create_domain(session: AsyncSession, name: str, sort: int = 0) -> dict:
    """Stage a domain for the caller to commit with its audit entry."""
    from uuid import uuid4
    name = _admin_name.validate_python(name)
    await catalog_names.require_available(session, models.Domain, name, "领域名已存在")
    d = models.Domain(id="dom_" + uuid4().hex[:10], name=name, sort=sort)
    session.add(d)
    await session.flush()
    await session.refresh(d)
    return domain_to_api(d)


async def update_domain(session: AsyncSession, did: str, name: str | None, sort: int | None) -> tuple[dict, dict] | None:
    """Capture both sides of the edit for the caller's audit transaction."""
    await catalog_names.lock_catalog(session, models.Domain)
    d = await session.get(models.Domain, did)
    if d is None:
        return None
    before = domain_to_api(d)
    if name is not None:
        name = _admin_name.validate_python(name)
        if name != d.name:
            await catalog_names.check_available(session, models.Domain, name, "领域名已存在", exclude_id=did)
        d.name = name
    if sort is not None:
        d.sort = sort
    return before, domain_to_api(d)


async def _lock_domains(session: AsyncSession, ids: list[str]) -> list[models.Domain]:
    # A user assignment and deletion must agree on which domains still exist.
    domain = models.Domain
    if session.get_bind().dialect.name == "sqlite":
        # SQLite ignores FOR UPDATE. Reserve the writer before checking references.
        await session.execute(update(domain).where(domain.id.in_(ids)).values(id=domain.id))
    rows = await session.scalars(select(domain).where(domain.id.in_(ids))
                                 .order_by(domain.id).with_for_update())
    return list(rows)


async def validate_user_domains(session: AsyncSession, ids: list[str] | None) -> None:
    if ids and len(await _lock_domains(session, ids)) != len(set(ids)):
        raise ValueError("所选业务域不存在，请刷新后重新选择")


async def delete_domain(session: AsyncSession, did: str) -> dict:
    # Match the update lock order before acquiring the row lock for deletion.
    await catalog_names.lock_catalog(session, models.Domain)
    domains = await _lock_domains(session, [did])
    if not domains:
        return {"ok": False, "reason": "not_found"}
    d = domains[0]
    if d.is_system:
        return {"ok": False, "reason": "system"}
    assignments = await session.scalars(select(models.User.domains))
    if any(did in {str(item) for item in (ids or [])} for ids in assignments):
        return {"ok": False, "reason": "in_use"}
    await session.delete(d)
    await session.commit()
    return {"ok": True}


# Initial setup creates the root organization, default roles, and super administrator when no users exist.

async def upgrade_builtin_role_permissions(session: AsyncSession) -> None:
    """Apply newly introduced built-in role permissions once without overwriting later organization
    customizations.
    """
    marker = await session.get(models.AppSetting, _BUILTIN_ROLE_PERMISSIONS_VERSION)
    if marker is not None:
        return
    rows = list((await session.execute(select(models.Role).where(
        models.Role.is_system.is_(True)
    ))).scalars().all())
    defaults = {
        "系统管理员": ALL_KEYS,
        "部门管理员": _DEPT_ADMIN_PERMS,
    }
    for role in rows:
        expected = defaults.get(role.name)
        if expected is None:
            continue
        role.permissions = valid_keys(list(dict.fromkeys([
            *(role.permissions or []), *expected,
        ])))
    session.add(models.AppSetting(
        key=_BUILTIN_ROLE_PERMISSIONS_VERSION, value="1"))
    await session.commit()


async def bootstrap(session: AsyncSession) -> None:
    n = await session.scalar(select(func.count()).select_from(models.User))
    if not n:
        s = get_settings()
        password = client_access.validate_password(s.admin_pass, new_account=True)
        root = None
        if not await session.scalar(select(func.count()).select_from(models.OrgUnit)):
            root = models.OrgUnit(name="总部", data_source="business")
            session.add(root)
            await session.flush()
        else:
            root = (await session.execute(select(models.OrgUnit).limit(1))).scalar_one()
        if not await session.scalar(select(func.count()).select_from(models.Role)):
            session.add(models.Role(name="系统管理员", permissions=list(ALL_KEYS), is_system=True))
            session.add(models.Role(name="部门管理员", permissions=list(_DEPT_ADMIN_PERMS), is_system=True))
        session.add(models.User(
            username=s.admin_user, password_hash=hash_password(password),
            display_name="超级管理员", org_id=root.id, is_super=True, is_active=True,
        ))
        await session.commit()
    await upgrade_builtin_role_permissions(session)
