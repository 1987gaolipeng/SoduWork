"""Pydantic API contracts for tasks and clients, using camelCase fields and millisecond timestamps.

"""
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from .models import Client, Task


def _ms(dt: datetime | None) -> int | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def task_to_api(t: Task) -> dict[str, Any]:
    from .services.task_requirements import fields as requirement_fields
    return {
        **requirement_fields(t),
        "id": t.id,
        "title": t.title,
        "source": t.source,
        "note": t.note,
        "status": t.status,
        "urgent": t.urgent,
        "important": t.important,
        "created": _ms(t.created_at),
        # Database onupdate may expire this attribute after a flush. The async
        # requirement projection reloads it in bulk; a synchronous DTO must not
        # perform implicit database I/O (MissingGreenlet during dispatch).
        "updatedAt": _ms(vars(t).get("updated_at")),
        "handler": t.handler,
        "result": t.result,
        "origin": t.origin,
        "externalId": t.external_id,
        "externalUrl": t.external_url,
        "externalActor": t.external_actor,
        "integrationId": t.integration_id,
        "ownerClientId": t.owner_client_id,
        # Task metadata.
        "priority": getattr(t, "priority", None) or "normal",
        "start": _ms(getattr(t, "start_at", None)),
        "due": _ms(getattr(t, "due_at", None)),
        "actualStart": _ms(getattr(t, "actual_start_at", None)),
        "actualEnd": _ms(getattr(t, "actual_end_at", None)),
        "tags": list(getattr(t, "tags", None) or []),
        "createdBy": getattr(t, "created_by", None),
        "createdByName": getattr(t, "created_by_name", None) or "",
        "assigneeUserId": getattr(t, "assignee_user_id", None),
        # Deliverable URL and review metadata.
        "artifactUrl": getattr(t, "artifact_url", None) or "",
        "reviewedAt": _ms(getattr(t, "reviewed_at", None)),
        "reviewedBy": getattr(t, "reviewed_by", None),
        "reviewedByName": getattr(t, "reviewed_by_name", None) or "",
        # Completion receipt for the requester.
        "requesterUserId": getattr(t, "requester_user_id", None),
        "requesterName": getattr(t, "requester_name", None) or "",
        "requesterContact": getattr(t, "requester_contact", None) or "",
        "recur": getattr(t, "recur", None),
        "recurAt": _ms(getattr(t, "recur_at", None)),
        "remindAt": _ms(getattr(t, "remind_at", None)),
        "reminded": bool(getattr(t, "reminded", False) or False),
        "progress": list(getattr(t, "progress", None) or []),
        "domainId": getattr(t, "domain_id", None) or "",
        "workScenarioKey": getattr(t, "work_scenario_key", "") or "",
        "workScenarioName": getattr(t, "work_scenario_name", "") or "",
        "workRouting": dict(getattr(t, "work_routing", None) or {}),
        "poolOrgId": getattr(t, "pool_org_id", None),
        # Project orchestration.
        "projectId": getattr(t, "project_id", None),
        "repoId": getattr(t, "repo_id", "") or "",
        "extRepo": getattr(t, "ext_repo", "") or "",
        # UI state for ms_auto.
        "msAuto": bool(getattr(t, "ms_auto", False)),
        "deps": list(getattr(t, "deps", None) or []),
    }


def client_to_api(c: Client, offline_after: int = 30) -> dict[str, Any]:
    online = False
    if c.last_seen_at is not None:
        last = c.last_seen_at if c.last_seen_at.tzinfo else c.last_seen_at.replace(tzinfo=timezone.utc)
        online = (datetime.now(timezone.utc) - last).total_seconds() <= offline_after
    return {
        "id": c.id,
        "name": c.name,
        "platform": c.platform,
        "version": c.app_version,
        "online": online,
        "lastSeen": _ms(c.last_seen_at),
        "createdAt": _ms(c.created_at),
        "ownerUserId": c.user_ref,  # Client ownership for RBAC scope checks.
        "authState": getattr(c, "auth_state", "pending") or "pending",
        "activatedAt": _ms(getattr(c, "activated_at", None)),
        "revokedAt": _ms(getattr(c, "revoked_at", None)),
    }


class TaskCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    kind: str = "requirement"
    acceptanceCriteria: list[str] = Field(default_factory=list, max_length=50)
    triageStage: str = "ready"
    visibility: str = "related"
    workScenarioName: str = ""
    workRouting: dict[str, Any] = Field(default_factory=dict)
    title: str = "未命名"
    source: str = ""
    note: str = ""
    status: str = "todo"
    urgent: Optional[bool] = None
    important: Optional[bool] = None
    handler: str = "me"
    result: str = ""
    # Task metadata.
    priority: str = "normal"                 # low|normal|high|critical
    start: Optional[int] = None              # Planned start time in milliseconds.
    due: Optional[int] = None                # Due time in milliseconds.
    actualStart: Optional[int] = None
    actualEnd: Optional[int] = None
    tags: list[str] = Field(default_factory=list)
    assigneeUserId: Optional[str] = None
    recur: Optional[str] = None              # daily|weekly|monthly
    recurAt: Optional[int] = None            # Next due time in milliseconds.
    remindAt: Optional[int] = None           # Reminder time in milliseconds.
    domainId: str = ""                       # Responsibility domain ID.
    workScenarioKey: str = ""                # Work type; the server captures other snapshot fields.
    requesterUserId: Optional[str] = None    # Internal requester user ID for completion notifications.
    requesterName: str = ""                  # External requester display name.
    requesterContact: str = ""               # External contact details; empty for an internal requester.
    projectId: Optional[str] = None          # Associated project.
    repoId: str = ""                         # Target repository for workflows and Runner execution.
    progress: list[dict] = Field(default_factory=list)
    deps: list[str] = Field(default_factory=list)  # Prerequisite task IDs; all must complete before this task is ready.


class TaskUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    kind: Optional[str] = None
    acceptanceCriteria: Optional[list[str]] = Field(default=None, max_length=50)
    triageStage: Optional[str] = None
    archivedAt: Optional[int] = None
    visibility: Optional[str] = None
    automationScheduleId: Optional[str] = None
    requirementVersion: Optional[int] = None
    workScenarioName: Optional[str] = None
    workRouting: Optional[dict[str, Any]] = None
    title: Optional[str] = None
    source: Optional[str] = None
    note: Optional[str] = None
    status: Optional[str] = None
    urgent: Optional[bool] = None
    important: Optional[bool] = None
    handler: Optional[str] = None
    result: Optional[str] = None
    priority: Optional[str] = None
    start: Optional[int] = None
    due: Optional[int] = None
    actualStart: Optional[int] = None
    actualEnd: Optional[int] = None
    tags: Optional[list[str]] = None
    assigneeUserId: Optional[str] = None
    recur: Optional[str] = None
    recurAt: Optional[int] = None
    remindAt: Optional[int] = None
    reminded: Optional[bool] = None
    domainId: Optional[str] = None
    workScenarioKey: Optional[str] = None
    progress: Optional[list] = None           # Replace the complete progress list.
    projectId: Optional[str] = None
    repoId: Optional[str] = None
    requesterUserId: Optional[str] = None
    requesterName: Optional[str] = None
    requesterContact: Optional[str] = None
    deps: Optional[list[str]] = None


class BatchUpdate(BaseModel):
    ids: list[str]
    patch: TaskUpdate


class ClientRegister(BaseModel):
    model_config = ConfigDict(extra="ignore")
    device: str
    name: Optional[str] = None
    platform: Optional[str] = None
    version: Optional[str] = None
    # Client-configured work root retained for unattended path resolution; see services/workdirs.py.
    workRoot: Optional[str] = None


class AdminLogin(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    user: str
    pw: str = Field(default="", alias="pass")  # Login form fields: user and pass.


class DispatchCreate(BaseModel):
    """Task creation fields plus dispatch targets."""
    model_config = ConfigDict(extra="ignore")
    title: str = "未命名"
    note: str = ""
    status: str = "todo"
    urgent: Optional[bool] = None
    important: Optional[bool] = None
    handler: str = "me"
    priority: str = "normal"
    start: Optional[int] = None
    due: Optional[int] = None
    tags: list[str] = []
    domainId: str = ""
    workScenarioKey: str = ""
    projectId: Optional[str] = None
    deps: list[str] = []
    targets: list[str] = []
    requesterUserId: Optional[str] = None
    requesterName: str = ""
    requesterContact: str = ""


# Shared aggregation contracts.

class Envelope(BaseModel):
    """Normalized integration envelope shared by push and pull ingestion."""
    model_config = ConfigDict(extra="ignore")
    external_id: str
    external_url: Optional[str] = None
    title: str = "未命名"
    note: str = ""
    status: str = "todo"                 # Normalized state: todo, doing, done, or cancel.
    assignee: Optional[str] = None       # Resolve the external assignee through an integration binding to a target client.
    urgent: Optional[bool] = None
    important: Optional[bool] = None
    source_label: Optional[str] = None   # Human-readable display text, such as an issue reference.
    # Issue-integration routing: integration_binding maps assignee; repo_binding maps ext_repo.
    ext_repo: Optional[str] = None        # External repository ID or name mapped to a Repo.
    severity: Optional[str] = None        # Normalize supported severity labels to task priority, including urgent.
    reporter: Optional[str] = None        # Requester who receives the completion notification.


class IntegrationCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    type: str = "generic"
    config: dict = {}                    # GitLab configuration stores base_url and project; tokens remain in environment variables.


class IntegrationUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    enabled: Optional[bool] = None
    config: Optional[dict] = None        # Merge configuration only when supplied.


class BindingCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    integration_id: str
    external_actor: str
    client_id: str


class AssignBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    client_id: str
    create_binding: bool = True          # Also bind external_actor to the target client.


# Organization roles and users.

class OrgCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    parentId: Optional[str] = None
    sort: int = 0


class OrgUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: Optional[str] = None
    parentId: Optional[str] = None
    sort: Optional[int] = None


class RoleCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    permissions: list[str] = []


class RoleUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: Optional[str] = None
    permissions: Optional[list[str]] = None


class UserTokenQuota(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["inherit", "limited", "unlimited"] = "inherit"
    limit: int = Field(default=0, ge=0, le=10_000_000_000_000, strict=True)


class UserCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    username: str
    password: str
    displayName: str = ""
    orgId: Optional[str] = None
    roleId: Optional[str] = None
    positions: Optional[list] = None
    domains: Optional[list] = None
    tokenQuota: Optional[UserTokenQuota] = None


class UserUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    displayName: Optional[str] = None
    orgId: Optional[str] = None
    roleId: Optional[str] = None
    isActive: Optional[bool] = None
    password: Optional[str] = None
    positions: Optional[list] = None
    domains: Optional[list] = None
    tokenQuota: Optional[UserTokenQuota] = None


class AssignUserBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    userId: Optional[str] = None         # An empty user ID unassigns the client.


# Legacy WorkflowCreate and FlowTemplate contracts are retired.


def integration_to_api(i, stats: dict | None = None,
                       *, reveal_token: bool = False) -> dict[str, Any]:
    cfg = dict(i.config or {})
    if "token" in cfg:
        cfg["token"] = "***"  # Mask any credential accidentally present in config; normal secrets stay outside persisted config.
    # PPM polling credentials are write-only: persist them for unattended polling but return only masks.
    if "mcpKey" in cfg:
        cfg["mcpKey"] = "***"
    if isinstance(cfg.get("keycloak"), dict):
        kc = dict(cfg["keycloak"])
        for k in ("clientSecret", "password"):
            if kc.get(k):
                kc[k] = "***"
        cfg["keycloak"] = kc
    # Return only whether the fixed pull account is configured, never its secret.
    pull = cfg.get("pullAuth") if isinstance(cfg.get("pullAuth"), dict) else None
    pull_user = str((pull or {}).get("user") or "")
    pull_kind = str((pull or {}).get("kind") or "")
    pull_set = bool(str((pull or {}).get("secret") or "").strip())
    if pull is not None:
        cfg["pullAuth"] = {"user": pull_user, "kind": pull_kind, "secretSet": pull_set}
    d = {
        "id": i.id,
        "type": i.type,
        "name": i.name,
        "enabled": i.enabled,
        "config": cfg,
        "cursor": i.cursor or {},  # Pull cursor status, including updated_after.
        "ingestTokenSet": bool(str(i.ingest_token or "").strip()),
        "createdAt": _ms(i.created_at),
        # Administrative health state: normal, error, or never.
        "lastPullAt": _ms(getattr(i, "last_pull_at", None)),
        "lastPullOk": getattr(i, "last_pull_ok", None),
        "lastPullError": getattr(i, "last_pull_error", None),
        "lastPullCount": getattr(i, "last_pull_count", 0) or 0,
        "repositorySyncAt": _ms(getattr(i, "repository_sync_at", None)),
        "repositorySyncOk": getattr(i, "repository_sync_ok", None),
        "repositorySyncError": getattr(i, "repository_sync_error", None),
        "repositorySyncCount": getattr(i, "repository_sync_count", 0) or 0,
        # Configured identity and state of the fixed pull account.
        "pullAccountUser": pull_user,
        "pullAccountKind": pull_kind,
        "pullAccountSet": pull_set,

        "lastIngestAt": _ms(getattr(i, "last_ingest_at", None)),
    }
    if reveal_token and i.ingest_token:
        d["ingestToken"] = i.ingest_token
    if stats:
        d.update(stats)
    return d


def attachment_to_api(a) -> dict[str, Any]:
    from .services import delivery_manifest, resource_access

    ct = a.content_type or ""
    uploaded = getattr(a, "uploaded_by", None) or ""
    by_agent = str(uploaded).startswith("agent:")
    role = getattr(a, "role", None) or ("output" if by_agent else "input")
    if role == "input" and (by_agent or str(uploaded).lower() in {"soduwork ai", "soduwork"}):
        role = "output"  # Legacy role defaults must not classify AI outputs as human inputs.
    evidence_meta = getattr(a, "evidence_meta", None) or {}
    explicit_category = str(evidence_meta.get("category") or "").strip().lower()
    category = explicit_category if explicit_category in {"primary", "supporting", "evidence", "internal"} else \
        delivery_manifest.classify_name(a.filename, role=role, meta=evidence_meta)
    return {
        "id": a.id,
        "taskId": a.task_id,
        "filename": a.filename,
        "contentType": ct,
        "size": a.size,
        "sha256": (getattr(a, "evidence_meta", None) or {}).get("sha256", ""),
        "isImage": resource_access.is_inline_image(ct),
        "url": resource_access.attachment_url(a.id),
        "createdAt": _ms(a.created_at),
        # Uploader identity: device ID, agent:SoduWork, or agent:multica.
        # Group AI outputs separately from human attachments.
        "uploadedBy": uploaded,
        "byAgent": by_agent,
        "role": role,
        "sourceRef": getattr(a, "source_ref", None) or "",
        "workflowRunId": getattr(a, "workflow_run_id", None) or "",
        "nodeRunId": getattr(a, "node_run_id", None) or "",
        "evidenceMeta": evidence_meta,
        "category": category,
    }


def binding_to_api(b) -> dict[str, Any]:
    return {
        "id": b.id,
        "integrationId": b.integration_id,
        "externalActor": b.external_actor,
        "clientId": b.client_id,
    }
