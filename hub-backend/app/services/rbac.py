"""Organization, role, and user management with RBAC subtree scope. Super administrators see all;
other users are scoped to their organization subtree. Clients inherit organization through
user_ref.
"""
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..auth import hash_password
from ..config import get_settings
from ..permissions import ALL_KEYS, valid_keys
from ..schemas import _ms

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
    return {"id": o.id, "name": o.name, "parentId": o.parent_id, "sort": o.sort, "createdAt": _ms(o.created_at)}


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
    return result


def position_to_api(p: models.Position) -> dict:
    return {
        "id": p.id, "orgId": p.org_id, "name": p.name,
        "category": p.category or "", "description": p.description or "",
        "competencies": list(p.competencies or []), "sort": p.sort,
        "isSystem": p.is_system,
    }


def domain_to_api(d: models.Domain) -> dict:
    return {"id": d.id, "name": d.name, "sort": d.sort, "isSystem": d.is_system}


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

async def list_orgs(session: AsyncSession, scope: set[str] | None) -> list[dict]:
    q = select(models.OrgUnit).order_by(models.OrgUnit.sort, models.OrgUnit.created_at)
    if scope is not None:
        q = q.where(models.OrgUnit.id.in_(scope or {"__none__"}))
    res = await session.execute(q)
    return [org_to_api(o) for o in res.scalars().all()]


async def create_org(
    session: AsyncSession, name: str, parent_id: str | None, sort: int = 0,
    *, scope: set[str] | None,
) -> dict:
    """Create below an authorized parent; only super users may create a root."""
    pid = str(parent_id or "").strip() or None
    if scope is not None and (not pid or pid not in scope):
        raise OrgMutationError("out_of_scope")
    if pid and await session.get(models.OrgUnit, pid) is None:
        raise OrgMutationError("parent_not_found")
    o = models.OrgUnit(name=name or "未命名部门", parent_id=pid, sort=sort)
    session.add(o)
    await session.commit()
    await session.refresh(o)
    return org_to_api(o)


async def update_org(
    session: AsyncSession, oid: str, name: str | None,
    parent_id: str | None, sort: int | None, *, scope: set[str] | None,
) -> dict | None:
    """Update only an authorized node and keep the department tree acyclic."""
    o = await session.get(models.OrgUnit, oid)
    if o is None:
        return None
    if scope is not None and oid not in scope:
        raise OrgMutationError("out_of_scope")
    if name is not None:
        o.name = name
    if parent_id is not None:
        pid = str(parent_id or "").strip() or None
        if scope is not None and (not pid or pid not in scope):
            raise OrgMutationError("out_of_scope")
        if pid:
            if await session.get(models.OrgUnit, pid) is None:
                raise OrgMutationError("parent_not_found")
            if pid == oid or pid in await subtree_org_ids(session, oid):
                raise OrgMutationError("cycle")
        o.parent_id = pid  # Only super administrators may use an empty parent to move an organization to the root.
    if sort is not None:
        o.sort = sort
    await session.commit()
    await session.refresh(o)
    return org_to_api(o)


async def delete_org(
    session: AsyncSession, oid: str, *, scope: set[str] | None,
) -> dict:
    o = await session.get(models.OrgUnit, oid)
    if o is None:
        return {"ok": False, "reason": "not_found"}
    if scope is not None and oid not in scope:
        raise OrgMutationError("out_of_scope")
    child = await session.scalar(select(func.count()).select_from(models.OrgUnit).where(models.OrgUnit.parent_id == oid))
    if child:
        return {"ok": False, "reason": "has_children"}
    users = await session.scalar(select(func.count()).select_from(models.User).where(models.User.org_id == oid))
    if users:
        return {"ok": False, "reason": "has_users"}
    deleted = {"id": o.id, "name": o.name}
    await session.delete(o)
    await session.commit()
    return {"ok": True, **deleted}


# Roles.

async def list_roles(session: AsyncSession) -> list[dict]:
    res = await session.execute(select(models.Role).order_by(models.Role.created_at))
    return [role_to_api(r) for r in res.scalars().all()]


async def create_role(session: AsyncSession, name: str, permissions: list[str]) -> dict:
    r = models.Role(name=name or "未命名角色", permissions=valid_keys(permissions))
    session.add(r)
    await session.commit()
    await session.refresh(r)
    return role_to_api(r)


async def update_role(session: AsyncSession, rid: str, name: str | None, permissions: list[str] | None) -> dict | None:
    r = await session.get(models.Role, rid)
    if r is None:
        return None
    if name is not None:
        r.name = name
    if permissions is not None:
        r.permissions = valid_keys(permissions)
    await session.commit()
    await session.refresh(r)
    return role_to_api(r)


async def delete_role(session: AsyncSession, rid: str) -> dict:
    r = await session.get(models.Role, rid)
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

async def list_users(session: AsyncSession, scope: set[str] | None) -> list[dict]:
    q = select(models.User).order_by(models.User.created_at)
    if scope is not None:
        q = q.where(models.User.org_id.in_(scope or {"__none__"}))
    res = await session.execute(q)
    users = list(res.scalars().all())
    from . import client_access
    quotas = await client_access.user_quotas(session, [u.id for u in users])
    return [user_to_api(u, token_quota=quotas.get(u.id, {"mode": "inherit", "limit": 0})) for u in users]


async def get_user_by_username(session: AsyncSession, username: str) -> models.User | None:
    res = await session.execute(select(models.User).where(models.User.username == username))
    return res.scalar_one_or_none()


async def create_user(session: AsyncSession, username: str, password: str, display_name: str,
                      org_id: str | None, role_id: str | None, positions: list | None = None,
                      domains: list | None = None, *, token_quota=None) -> dict:
    u = models.User(
        username=username, password_hash=hash_password(password or ""),
        display_name=display_name or username, org_id=org_id or None, role_id=role_id or None,
        positions=list(positions or []), domains=list(domains or []),
    )
    session.add(u)
    if token_quota is not None:
        from . import client_access
        await session.flush()
        token_quota = await client_access.save_user_quota(session, u.id, token_quota)
    await session.commit()
    await session.refresh(u)
    return user_to_api(u, token_quota=token_quota or {"mode": "inherit", "limit": 0})


async def update_user(session: AsyncSession, uid: str, patch: dict) -> dict | None:
    u = await session.get(models.User, uid)
    if u is None:
        return None
    if "displayName" in patch and patch["displayName"] is not None:
        u.display_name = patch["displayName"]
    if "orgId" in patch and patch["orgId"] is not None:
        u.org_id = patch["orgId"] or None
    if "roleId" in patch and patch["roleId"] is not None:
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
    if patch.get("password"):
        u.password_hash = hash_password(patch["password"])
        revoke_sessions = True
    if revoke_sessions:
        u.auth_version = int(u.auth_version or 0) + 1
    from . import client_access
    if patch.get("tokenQuota") is not None:
        quota = await client_access.save_user_quota(session, uid, patch["tokenQuota"])
    else:
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
            session.add(models.Position(id=pid, name=name, sort=sort, is_system=True))
            changed = True
    if changed:
        await session.commit()


async def list_positions(
    session: AsyncSession, org_ids: set[str] | None = None
) -> list[dict]:
    """List professional profiles within the supplied scope; org_ids=None is reserved for super
    administrators.
    """
    query = select(models.Position)
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


async def list_domains(session: AsyncSession) -> list[dict]:
    res = await session.execute(select(models.Domain).order_by(models.Domain.sort, models.Domain.created_at))
    return [domain_to_api(d) for d in res.scalars().all()]


async def create_domain(session: AsyncSession, name: str, sort: int = 0) -> dict:
    from uuid import uuid4
    d = models.Domain(id="dom_" + uuid4().hex[:10], name=name or "未命名领域", sort=sort)
    session.add(d)
    await session.commit()
    await session.refresh(d)
    return domain_to_api(d)


async def update_domain(session: AsyncSession, did: str, name: str | None, sort: int | None) -> dict | None:
    d = await session.get(models.Domain, did)
    if d is None:
        return None
    if name is not None:
        d.name = name
    if sort is not None:
        d.sort = sort
    await session.commit()
    await session.refresh(d)
    return domain_to_api(d)


async def delete_domain(session: AsyncSession, did: str) -> dict:
    d = await session.get(models.Domain, did)
    if d is None:
        return {"ok": False, "reason": "not_found"}
    if d.is_system:
        return {"ok": False, "reason": "system"}
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
        root = None
        if not await session.scalar(select(func.count()).select_from(models.OrgUnit)):
            root = models.OrgUnit(name="总部")
            session.add(root)
            await session.flush()
        else:
            root = (await session.execute(select(models.OrgUnit).limit(1))).scalar_one()
        if not await session.scalar(select(func.count()).select_from(models.Role)):
            session.add(models.Role(name="系统管理员", permissions=list(ALL_KEYS), is_system=True))
            session.add(models.Role(name="部门管理员", permissions=list(_DEPT_ADMIN_PERMS), is_system=True))
        session.add(models.User(
            username=s.admin_user, password_hash=hash_password(s.admin_pass),
            display_name="超级管理员", org_id=root.id, is_super=True, is_active=True,
        ))
        await session.commit()
    await upgrade_builtin_role_permissions(session)
