# SoduWork Hub backend

[简体中文](README.md) · **English** · [Developer guide](../docs/development.en.md#hub-backend)

Hub provides identity, authorization, execution governance, plugins, shared materials, and desktop connectivity. It uses FastAPI and asynchronous SQLAlchemy with PostgreSQL; local development can use SQLite.

## Start locally

For a first session, use `python start.py` from the repository root; it creates an isolated database, environment, and administrator.

For direct backend development, create a dedicated environment:

```sh
cd hub-backend
python -m venv .venv
```

Windows PowerShell:

```powershell
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m uvicorn app.main:app --reload --port 9080
```

macOS / Linux:

```sh
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --reload --port 9080
```

Direct development uses local configuration and data; keep it separate from real deployments. Configure bootstrap identity with `ADMIN_USER` / `ADMIN_PASS` in a private environment; no shared default password is supplied. The root launcher handles this interactively instead.

API documentation: **http://127.0.0.1:9080/docs**. Health check: `GET /healthz`.

## Offline quality gate

Use the dedicated test environment, not a production service environment:

```sh
python -m pip install -r requirements-test.txt
python quality_gate.py --list
python quality_gate.py --profile release --scope backend
python quality_gate.py --profile extended --scope all
```

The manifest in `quality_manifest.py` registers checks and their profiles. Unregistered checks block the gate. `live` checks connect to real Hubs, Runners, providers, or business data; they are not part of default offline acceptance.

## Database configuration

Set `DATABASE_URL` in private configuration when overriding the SQLite default:

| Environment | Value |
| --- | --- |
| Local SQLite | `sqlite+aiosqlite:///./soduwork_hub.db` |
| PostgreSQL | `postgresql+asyncpg://soduwork:<PASSWORD>@db.example.com:5432/soduwork` |
| Docker self-hosting | Run `python ops/self-host/deploy.py up` from the repository root; it generates independent credentials |

The PostgreSQL value is a placeholder. Use a dedicated database and a minimally privileged account. Never commit environment files or credentials. See [self-hosting](../ops/self-host/README.en.md) for backups and deployment.

## API and trust boundaries

- Devices enroll with `POST /api/v1/clients/enroll`, then use a short-lived device session. Device long-term keys remain in the Electron main process; Hub stores only their digest.
- Business requests use `Authorization: Device <session>`. WebSocket connectivity uses the same short-lived session at `/api/v1/ws`.
- Tasks use `/api/v1/tasks`, task-specific operations, batch updates, completed-task clearing, and agent run/retry/takeover routes. Configuration uses `/api/v1/config`.
- Administrators sign in at `/api/v1/admin/login` and use bearer tokens for administrator APIs, including clients, tasks, and dispatch.
- Long-term device keys must not enter renderers, logs, or URLs. Server state is authoritative; offline client caches must not overwrite it.

See [OAuth deployment and validation](CONNECTOR_OAUTH.en.md) for connector credentials and authorization.

## Requirement migration and access

Task APIs retain their public contract. `requirementContent` contains requirement text; execution `title/note` can contain private context. Updates carry `requirementVersion` and write only authorized projections. `canEditRequirement` and `canViewExecution` are separate capabilities.

Migration 0053 preserves original records in `legacy_requirements` and records creator/requester/manager scope in `task_requirement_access`. Execution-only users may read their own snapshots and materials without gaining access to the full requirement. Lists, details, attachments, and WebSockets share these rules.

Back up matching source and database before upgrading. This additive migration retains old tables; files remain stored separately. Incompatible visibility fails and rolls back rather than broadening permissions. Migration is repeatable. Rollback requires the pre-upgrade database and matching source. Retired `/work-items` routes return 410; legacy task-create compatibility remains.

Upgrade checks:

```sh
python -B tests/unified_requirements_upgrade.py --sqlite
python -B tests/unified_requirements_upgrade.py
```

The second command creates and tears down an isolated PostgreSQL test container. Do not point it at a business database. Access regression: `test_unified_requirements_acl.py`.

See [release scope](../docs/release-scope.en.md) for distribution boundaries.
