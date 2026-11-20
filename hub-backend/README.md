# SoduWork Hub backend

[简体中文](README.zh-CN.md) · **English** · [Developer guide](../docs/development.en.md#hub-backend)

Command examples use `sh start.sh` on macOS/Linux. On Windows, use `.\start.cmd` in PowerShell or `start.cmd` in Command Prompt with the same arguments. Standalone Python tools use `python3`; use `py` on Windows, or `python` inside an activated virtual environment.

Hub provides identity, authorization, execution governance, plugins, shared materials, and desktop connectivity. It uses FastAPI and asynchronous SQLAlchemy with PostgreSQL; local development can use SQLite.

## Start locally

For a first session, use `sh start.sh` from the repository root; it creates an isolated database, environment, and administrator.

For direct backend development, create a dedicated environment:

```sh
cd hub-backend
python3 -m venv .venv
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

## Desktop-local Runner event recovery

Desktop-local Runner executions persist their event destination separately from the
conversation alias. Their history does not enter Hub task delivery, and Hub outbox
pressure does not block local work; CPU, memory and execution concurrency still apply.
Queued desktop turns display queue wording instead of model-processing wording.

On upgrade, Runner recognizes old local chat streams only when their alias, runtime
and deterministic execution reference agree. Recovery persists confirmed local routing;
ambiguous records retain their original routing metadata. Confirmed local packets are copied to
private `local-events-*.archive` recovery files before removal from the active outbox;
Windows payloads retain DPAPI protection. Collection marks are preserved. Ambiguous
streams and real Hub events remain untouched, and NACK is never treated as ACK.
Recovery files are bounded to three times the configured outbox byte budget, including
encoding overhead. Archive failures retain the original packets and emit a diagnostic;
unrelated Hub delivery and collection continue subject to actual outbox capacity.
Keep these recovery files private and retain them until their contents have been reviewed.
Run `python3 -m unittest test_runner_event_scope test_runner_event_delivery` to verify
routing, restart recovery, interrupted archive writes, and Hub delivery preservation.

## Managed Pi execution

Managed Pi execution binds each Runner execution record to its own configuration and session directory under the Runner data root. Startup and follow-up turns use the same explicit path, independent of inherited desktop Pi settings or the operating system home-directory lookup. Model files contain an environment-variable reference for the credential; missing model configuration or failed file publication stops execution before Pi starts. Personal Pi and desktop-local model files are not modified. On upgrade, only the exact native session identified by the Runner record and matching workspace can be copied into the private directory; its original file remains unchanged. Established follow-up turns require an existing session rather than silently starting a new one.

After a Runner restart, recovery terminals bind the same owned history without restoring model credentials or changing its model file. A new managed turn still requires its own model authorization.

To verify this path with a real Runner and Pi subprocess against a disposable authenticated Hub and loopback model, install the client dependencies and run `python3 e2e_pi_dispatch_config.py --output /absolute/evidence/directory` from the backend test environment. The check covers dispatch, follow-up, output files, native terminal recovery after restart, and preservation of personal model configuration. It does not exercise a production model or native desktop UI.

## Concurrent Runner conversations

Desktop-private and Hub RPCs use bounded work, read, discovery and control lanes. A slow discovery or history read cannot occupy the workers reserved for stopping another conversation. Mutations of one execution reference remain ordered across both transports; stopping it invalidates older requests that have not reached durable admission. Requests rejected for transport capacity are explicitly unaccepted and may be retried with the same business ID. This does not change account authorization, local-model privacy or the adaptive CPU/memory execution budget.

Process creation runs outside the shared session lock. Cancellation retains the exact launch identity until process-tree cleanup is confirmed; an unconfirmed exit does not free its execution slot or authorize a replacement. Event-retention failures preserve the unsaved batch and retry it before resuming Hub-bound admission. An empty current snapshot or an unrelated acknowledgement cannot discard that batch. Desktop-local admission remains independent of Hub event retention.

Model metadata carries its privacy classification from snapshot capture to remote projection. Switching to a Hub model while a read is pending cannot expose an older local model identity or its token counts. Attachment reads and follow-up workers also retain cancellation ownership until the underlying operation finishes.

Run `python3 -m unittest test_runner_local_rpc test_runner_remote_rpc test_runner_event_delivery test_runner_usage_receipts test_runner_input_cleanup test_local_process_cleanup test_task_goal_stop_races` in the backend test environment. The private-pipe test uses a real Runner process and durable queue with synthetic discovery; process-cleanup tests use isolated operating-system children. These checks do not establish real-provider or Windows acceptance when run on another platform.

## Offline quality gate

Native requirement preparation can save `executionSubmissionChoice` independently of the effective `executionSubmissionMode`. For the `infer` choice, completed and validated primary artifacts resolve the mode to automatic review submission; explicit manual and ambiguous legacy manual values retain their behavior. Review remains a human action owned by the requirement creator. Current-turn delivery issues expose interrupted capture, invalid output or an unavailable creator without changing approval permissions. Upgrade desktop and Hub together for the new choice acknowledgment and issue receipts.

Use the dedicated test environment, not a production service environment:

```sh
python3 -m pip install -r requirements-test.txt
python3 quality_gate.py --list
python3 quality_gate.py --profile release --scope backend
python3 quality_gate.py --profile extended --scope all
```

The manifest in `quality_manifest.py` registers checks and their profiles. Unregistered checks block the gate. `live` checks connect to real Hubs, Runners, providers, or business data; they are not part of default offline acceptance.

Manual acceptance submission commits its review request and notification job together. The HTTP receipt does not wait for device notification delivery, so slow connections cannot leave a successfully submitted requirement looking retryable. The existing notification worker retries failed delivery and projects each recipient's current permissions. Run `python3 -m unittest test_local_requirement_delivery` for receipt, idempotency and transaction rollback regressions.

From `client/`, run `node e2e/run-requirements-isolated.cjs /absolute/evidence/directory /path/to/test/python requirements-manual-submit-race` for an isolated Electron/HTTP check using the production client timeout and synthetic slow notification recipients. The fixture has its own database and files; it does not use real accounts or send remote messages.

Offline checks own their subprocess trees and finish cleanup before returning, including when a command exits before its descendants. On Windows, the gate uses the repository's Windows PowerShell Job helper and releases the command only after Job assignment succeeds. Output is captured in a private temporary file so inherited output handles cannot extend a timeout indefinitely; failure reports retain output produced before the timeout. Run `python3 -m unittest test_quality_gate_cleanup` for real process cleanup regressions on the current platform.

Permission-controlled turns confirm that their execution host has exited before settlement or a replacement turn. A reliable Agent exit receipt allows up to 30 seconds for normal host cleanup, such as a frozen executable removing its extraction directory; cancellation and permission changes retain the shorter stop deadline. If termination cannot be confirmed, the original process remains tracked and blocks replacement. An answer or a successful kill request alone does not establish successful completion. Run `python3 -m unittest test_local_process_cleanup` to verify delayed shutdown and failed-termination behavior with isolated subprocesses.

Smoke checks live in [`smoke/`](smoke/). To run one directly, use its module from the `hub-backend/` directory, for example `python3 -m smoke.smoke_capabilities`. The quality gate selects the appropriate registered modules. Unit tests and `tests/` integration helpers keep their existing locations.

## DeepSeek Harness turn completion

DeepSeek runtime preflight checks the archive-locked sharp, koffi and ripgrep
packages for Windows, macOS and Linux on x64/arm64. macOS/Linux also require
libvips; Linux selects the glibc or musl binaries. Missing manifests, mismatched
versions and missing critical loaders/binaries prevent stage activation and
invalidate cached readiness. Failed repair leaves the active runtime intact.
Run `python3 -m smoke.smoke_dsh_runtime` for the offline platform matrix and
activation/cache regressions. These static checks do not certify arbitrary binary
corruption or macOS Gatekeeper acceptance; native ACP and tool execution still
require validation on the target platform.

DeepSeek ACP adapters 0.4.40 and 0.4.41 can return while their child agents are
still running. SoduWork's host-only preload waits for progressing descendants
through the native `waitForChildren` service, then rechecks the parent's idle
state and session sequence. Child results can wake another parent turn; its
latest output limit or error is preserved. Cancellation stops waiting, while
idle resident children do not keep a completed prompt open.

The preload applies an in-memory compatibility fix to the adapter's reviewed
prompt and tool-preview blocks on macOS, Linux and Windows. Installed packages and native session
files are not rewritten. Unknown adapter versions or changed reviewed blocks fail
with an update instruction instead of silently using the affected behavior.
The loader is included in source and frozen Runner packages.

Run `node --test client/tests/dsh-acp-settlement.test.cjs` from the root for
offline lifecycle and loader regressions. From `hub-backend`, run
`python3 e2e_dsh_subagent_settlement.py --adapter-entry /absolute/npm/root/@openma/deepseek-harness-acp/dist/bin.js --runtime-root /absolute/runner/data/agent-runtimes/dsh-host --node /absolute/path/to/node --output /absolute/evidence/directory`
for isolated acceptance against an explicitly selected installed adapter and a
synthetic loopback model. This does not exercise a production model or desktop UI.

On `max_tokens`, the reviewed adapter marks only native pending tool previews as
not executed before clearing them. DSH discards these calls before execution;
started tools remain unsettled until their real result arrives. The host preserves
this distinction through live and archived tool cards, including a later failure.

Once tool activity has settled, DeepSeek Harness can continue within the same
native session from saved results using smaller calls. Recovery is bounded to
one continuation, plus one more only after successful native compaction. If the
limit persists, the turn is reported as incomplete with retained progress instead
of a protocol error. Successful continuation clears the earlier truncation;
protocol and host-cleanup failures retain priority.

For managed model routes, SoduWork explicitly enables and budgets DeepSeek's
native automatic compaction. It runs between tool steps within the current turn.
Its threshold is the smaller of 80% of the
model context window and the space left after reserving the current output and
summary budgets. Summary output stays within the model's configured output cap;
it no longer inherits the native 65,536-token reservation. Ordinary output caps
are preserved; a cap that would consume almost the whole window is reduced to
leave input space. Native compaction keeps the existing session, tool results,
permissions and cancellation ownership, without requiring a new user message.
This does not turn a provider's individual output limit into a context overflow
or remove the bounded output recovery described above.

Run `python3 -m unittest test_dsh_gateway test_context_recovery
test_acp_error_messages test_local_turn_outcome` for model budgets and recovery
regressions. Configured or inferred context sizes still need to match the actual
provider; a window too small for the native instructions and tools cannot be made
usable by compression alone.

For a real native-process check, run `python3 e2e_dsh_auto_compaction.py` with
the same explicit `--adapter-entry`, `--runtime-root`, `--node` and `--output`
paths as the lifecycle check above. A synthetic loopback provider drives a 64k
window through repeated compression in one user prompt. The check compares the
old provider-only bundle, verifies durable checkpoints and completed tools, and
requires lower native usage receipts after compaction. This is not a production
model or desktop UI acceptance test.

Managed Kimi and Qwen also receive the selected model's context window instead
of inheriting a larger native default. Kimi receives an explicitly configured
output cap; Qwen retains the operator's sampling and output parameters. Both use
their own between-step compression. Managed Codex Harness receives the model
window and an 80% automatic-compaction threshold. Personal-account Codex keeps
its native model settings, while OpenCode already receives context/output limits
and retains native automatic compaction. Run `python3 -m unittest
test_kimi_runtime test_qwen_runtime test_acp_permission_inputs
test_codex_account_acp` for these configuration and isolation boundaries.

## Other harness terminal outcomes

Managed installs and updates use reviewed versions: DeepSeek ACP 0.4.41,
Kimi Code 2.6.2 and Qwen Code 0.27.4. Version checks refer to those targets,
including when the locally installed package is newer. SoduWork updates the
pins after compatibility validation; discovery does not replace installed software.

Kimi Code 2.6.2 and Qwen Code 0.27.4 can also translate a native output limit
into a successful ACP response. Host-only preloads preserve their native final
outcome, verify the complete reviewed source hashes, and reject unknown versions
with an update instruction. The preloads never change installed packages or tool
execution. They are packaged for macOS, Linux and Windows; Qwen now requires
Node 22.15 or later for the host loader, even if an older package declares a lower
engine requirement.

Kimi preserves the final provider stop reason across tool validation and rejects
native failed turns. Qwen retains its own bounded output recovery and propagates
recovery errors; its separate session-input budget is not relabeled as an output
limit. SoduWork's invocation-local Qwen settings select native
`model.loopProtection = "stop"`, so a detected repeated failure stops instead of
only warning. This overrides `warn`/`off` for the managed invocation without
changing operator files or lowering the general task budget. Neither harness
receives an additional host retry for exhausted output recovery.

Codex ACP negotiates its versioned `sessionFailure` capability and reads the
current prompt's typed failure before accepting `end_turn`; error prose alone is
not completion evidence. Invalid typed failures also stop settlement. The v1
capability also changes tool reports: omitted approval fields are restored only
from the same live tool call, and bounded terminal deltas and result snapshots
remain available in completed tool cards. Native subagent-session capabilities
are not enabled by this negotiation. Pi,
OpenCode, DeepSeek, Kimi and Qwen preserve a real later error over an earlier
truncation, while successful recovery clears the old truncation state.

Run `python3 -m unittest test_kimi_runtime test_qwen_runtime test_codex_acp_outcome
test_acp_error_messages test_local_turn_outcome` in the backend test environment.
The standalone `e2e_kimi_outcome.py`, `e2e_qwen_turn_outcome.py` and
`e2e_codex_acp_outcome.py` fixtures use
explicitly selected installed runtimes and isolated loopback providers; see their
`--help` for required paths. Codex acceptance also checks real permission
approvals/denials and command output. They do not exercise paid model services.

## Task text compatibility

Task creation with `POST /api/v1/tasks` and fields explicitly supplied to `PATCH`
or batch updates validate titles up to 200 characters and sources up to 120;
longer input returns 422 before writes. Reading historical records and updating
unrelated fields retain their original text.

`PUT /api/v1/tasks/{id}` is the desktop's idempotent synchronization and undo
contract. It accepts complete historical text because an unsent legacy task and
a task restored after deletion have no existing server row to identify them.
This compatibility endpoint intentionally does not enforce the POST/PATCH text
limits; account ownership and managed-source restrictions still apply.

Migration `0092_task_text_storage` widens PostgreSQL task text columns without
truncation, including adoption of unversioned databases. Existing SQLite tables
need no rebuild. Deploy the Hub migration before the updated desktop. The desktop
preserves full text and retries a queued PUT blocked solely by the old length
validation once; another rejection remains blocked for explicit review. Downgrade
refuses to narrow columns while overlong data exists. Back up the database and
matching application before upgrading.

## Database configuration

Domain ordering accepts signed 32-bit integers and legacy decimal strings.
Malformed values, booleans, fractions and overflow return HTTP 400 before any
record is changed. Omitting a rank or sending null keeps the existing rank on
PATCH; creation retains its zero default. Schedule numeric fields and client
update progress use the same integer validation, with their existing clamping
and optional-field defaults. New schedule timezone values must name a valid
IANA zone; omitted values keep the previous configuration, while null or empty
text selects the existing default. Historical invalid zones remain readable
through the default timezone fallback.

Migration `0091_domain_sort_validation` repairs historical SQLite domain ranks
whose stored type or range is invalid. Valid ranks, domain IDs and associations
are preserved. Repaired entries are placed after valid ranks when space remains;
if the maximum rank is exhausted, entries tie at that maximum and are ordered
by creation time and ID. Each repair first records
the original storage type, lossless original value and replacement in a
`domain.sort_repair` audit entry in the same transaction. The repair also runs
when adopting a pre-Alembic database and is idempotent. PostgreSQL domain data
is unchanged. Back up the database before upgrading; downgrade does not restore
invalid values. Administrators can review the audit entries and adjust ordering.

Offline regressions: `python3 -m unittest test_api_integer_validation
test_domain_sort_validation test_domain_sort_migration
test_schedule_update_input_validation`. These suites are registered in the
release quality gate.

Set `DATABASE_URL` in private configuration when overriding the SQLite default:

| Environment | Value |
| --- | --- |
| Local SQLite | `sqlite+aiosqlite:///./soduwork_hub.db` |
| PostgreSQL | `postgresql+asyncpg://soduwork:<PASSWORD>@db.example.com:5432/soduwork` |
| Docker self-hosting | Run `python3 ops/self-host/deploy.py up` from the repository root; it generates independent credentials |

The PostgreSQL value is a placeholder. Use a dedicated database and a minimally privileged account. Never commit environment files or credentials. See [self-hosting](../ops/self-host/README.md) for backups and deployment.

Bundled skill instructions are discovered from the deployed `skills/` directory.
Hub startup initializes a versioned policy in the existing `app_setting` record
`skills_cfg`. New installations and the first upgrade of a legacy policy make all
bundled skills available, including ones previously closed by administrators.
Later administrator opt-outs persist across restarts, and new bundled skills
default to available. Personal choices and imported-package approval remain
independent. See the [skill loading guide](../skills/README.md).

## OpenCode data isolation and existing conversations

Managed OpenCode keeps its database, data, state and cache under the Runner data root's `agents/opencode/` directory. Inherited `OPENCODE_DB` and XDG paths cannot redirect managed execution into a personal OpenCode installation. The parent Runner and standalone ACP bridge select the same private database; the user's home directory and injected model configuration remain unchanged.

Before starting either a new or resumed session, managed execution rejects child paths that escape this private directory and hard links on the database or its SQLite sidecars. An explicitly redirected Runner root and links that stay within its OpenCode directory remain supported. Fix the directory layout before retrying; rejected layouts never launch OpenCode or substitute a new session.

When an archived SoduWork conversation resumes, its recorded native session ID and workspace identify the history to recover. Compatible v1 session, message, part and todo records are imported from a stable, read-only file snapshot into the private database, together with related child sessions. Personal accounts, credentials and project permissions are not imported, and the original database and sidecars are not modified. A missing session, unsupported v2 history in the selected session or its children, active revert or remote workspace binding stops recovery with an explanation; it never silently starts a blank replacement session or downgrades the personal database. This also detects v2 history when the database still contains v1 tables, without blocking unrelated v1 sessions. If the personal database is changing during the snapshot, close personal OpenCode and retry. Existing conversation archives and native IDs remain available.

If an empty private session already exists, recoverable evidence of original history blocks continuing that empty session without replacing it. Legitimate private sessions remain resumable when personal storage is missing or unavailable. Canceling during compaction settles the stopped turn even if history recovery also fails, and a retired recovery cannot overwrite a newer turn.

Run `SODUWORK_TEST_OPENCODE_BIN=/absolute/path/to/opencode python3 -m unittest test_opencode_native_config` with the pinned managed binary and prepared SDK dependencies for native/ACP isolation and resume checks against a loopback model. These checks use synthetic databases and do not access personal history or a production model.

## OpenCode turn completion

Native and ACP OpenCode executions preserve the current turn's provider finish reason. An output-token limit is reported as incomplete even when partial text exists and the native process exits successfully; existing progress and the session remain available for manual continuation. The ACP adapter observes only native session/turn identifiers and stop reasons through an invocation-local plugin, and rejects missing completion evidence without retrying tools or changing permissions. Run `python3 e2e_opencode_turn_outcome.py --binary /path/to/opencode` for isolated loopback-provider acceptance using an explicitly selected installed binary.

## OpenCode installation and network diagnostics

Runner archive downloads, model-gateway reachability checks and secure control connections share one TLS configuration on macOS, Windows and Linux. By default, MIT-licensed `truststore` uses the installed operating system's trust: Security framework on macOS, CryptoAPI on Windows, and the system CA store through OpenSSL on Linux. No packaged public CA bundle is added. Missing native verification support or a rejected certificate fails without retrying under another trust policy. Certificate chains and hostnames remain verified. This does not change external native harnesses' own HTTPS configuration.

Nonempty `SSL_CERT_FILE` or `SSL_CERT_DIR` values explicitly replace default system trust with the configured CA file or OpenSSL hashed CA directory. A missing or invalid path fails without falling back to system or bundled roots. Supply the complete required trust set when configuring this override. Empty values select default system trust. HTTP clients load trust only for HTTPS requests, including redirects from HTTP; plain HTTP does not depend on certificate configuration. Existing download proxy selection and direct model-gateway routing are unchanged.

The managed installer tries an explicitly configured mirror, the connected Hub, then the official release. On macOS, archive downloads through the Python installer merge system HTTP/HTTPS proxy settings with environment overrides by scheme on every attempt. An explicitly empty proxy variable disables that scheme's system proxy. System-sourced proxies retain their system bypass rules alongside `NO_PROXY`; an empty `NO_PROXY` does not cancel the system exceptions. Explicit proxy overrides retain standard environment bypass behavior, and requests to the exact connected Hub origin stay direct. TLS certificate verification and pinned SHA-256 verification remain enabled. These download rules do not change npm dependency installation or model-gateway routing.

Prepare the Hub mirror using the same code revision and pinned OpenCode version expected by the clients. Running `fetch_opencode_assets.py` without arguments prepares only Windows assets. To serve Apple Silicon and Intel Macs, run from that Hub checkout's `hub-backend/` directory:

```sh
python3 fetch_opencode_assets.py darwin-arm64 darwin-x64 darwin-x64-baseline
```

The script verifies the pinned SHA-256 before publishing files under `downloads/opencode/`. After deploying those files, inspect `GET /api/v1/download/opencode/info` for the expected version, platform and `filename`, then download `/api/v1/download/opencode/{filename}` using that exact filename. `available: true` only proves a file exists; verify the downloaded bytes against the pinned digest. The Runner independently verifies that digest before extraction. Preparing files in a checkout does not establish that a remote Hub serves them.

For failed attempts, inspect the local Runner's `runner.log` for structured network diagnostics and the failed stage. A successful metadata request, partial download, checksum check or `--version` probe alone is not a completed installation: download, integrity check, extraction, executable version check, execution-dependency preparation and activation must all succeed. Model execution needs its own subsequent verification. Keep credentials and raw proxy configuration out of shared diagnostics; repair trusted certificate configuration rather than disabling TLS checks.

Verify the production network modules with real loopback HTTPS and a frozen PyInstaller probe in a dedicated environment containing `requirements-runner-build.txt` dependencies:

```sh
python3 e2e_runner_tls.py --output /absolute/evidence/directory
```

The check verifies the packaged native verifier, real TLS with a disposable trust anchor, strict explicit overrides, and rejection of untrusted or mismatched certificates. It does not modify the machine's trust store. `--source-only` exercises the same paths without freezing. These fixtures do not replace full desktop, production model or other operating-system verification.

## API and trust boundaries

- Devices enroll with `POST /api/v1/clients/enroll`, then use a short-lived device session. Device long-term keys remain in the Electron main process; Hub stores only their digest.
- Business requests use `Authorization: Device <session>`. WebSocket connectivity uses the same short-lived session at `/api/v1/ws`.
- Tasks use `/api/v1/tasks`, task-specific operations, batch updates, completed-task clearing, and agent run/retry/takeover routes. Configuration uses `/api/v1/config`.
- Administrators sign in at `/api/v1/admin/login` and use bearer tokens for administrator APIs, including clients, tasks, and dispatch.
- Long-term device keys must not enter renderers, logs, or URLs. Server state is authoritative; offline client caches must not overwrite it.

Disabling an account invalidates its existing device sessions and AI/tool tickets, returns devices to pending sign-in, and closes their event, terminal and Runner channels. Device keys, configuration and historical ownership are retained. Another active account can sign in on the same device; re-enabling the original account requires a new sign-in and never restores old sessions. Explicit administrator device bans remain revoked and block every account. Devices already revoked by older account-disable behavior require an administrator to review and activate them; account re-enablement does not automatically lift device bans.

Account conversation directory and source projections include `contentLocation`: `hub` for legacy Hub content, `source` for content retained by the original endpoint, `replica` for a valid migrated copy at the current source revision, or `unknown` when the reference cannot be established. The field does not expose private replica identifiers or grant access; clients must retain existing account, Hub, and execution checks. An unknown location must not be used to discard a potentially independent local copy.

See [OAuth deployment and validation](CONNECTOR_OAUTH.en.md) for connector credentials and authorization.

## Requirement migration and access

Task APIs retain their public contract. `requirementContent` contains requirement text; execution `title/note` can contain private context. Updates carry `requirementVersion` and write only authorized projections. `canEditRequirement` and `canViewExecution` are separate capabilities.

Requirement project selection uses the existing active Hub business-project catalog from `GET /api/v1/projects`, including its organization scope and public projects. Only the task's owning device and account may change or clear `projectId`, before any execution history, with the current `requirementVersion`; `null` clears the association. A repository-linked task's project stays fixed. Explicit new associations must be visible, active, and consistent with any repository. Unchanged legacy associations and repository-only callers retain their existing behavior; personal conversation projects are not Hub business projects.

Migration 0053 preserves original records in `legacy_requirements` and records creator/requester/manager scope in `task_requirement_access`. Users with access to only some original requirements may read their own snapshots and materials, but cannot edit the combined requirement or read the others. Sharing a requirement does not grant access to execution records, comments, or output attachments. Lists, details, attachments, and WebSockets share these rules. Restore archived requirements before dispatching them; archiving completed work preserves its acceptance and completion state.

Back up matching source and database before upgrading. Migration 0053 transfers the records transactionally and drops the old requirements table; file contents and object-storage keys remain unchanged. Merging requirements with different visibility scopes fails and rolls back rather than broadening permissions. Repeating the migration does not duplicate records. Automatic downgrade is disabled; rollback requires the verified pre-upgrade database and matching application. Retired `/work-items` routes return 410; the old `work.task.create` plugin method remains an alias for unified Task creation.

Upgrade checks:

```sh
python3 -B tests/unified_requirements_upgrade.py --sqlite
python3 -B tests/unified_requirements_upgrade.py
```

The second command creates and tears down an isolated local PostgreSQL instance. Do not point it at a business database. `test_unified_requirements_acl.py` exercises access controls through authenticated HTTP identities and WebSocket projections after real migration.

See [release scope](../docs/release-scope.en.md) for distribution boundaries.

## Non-Pi task continuation

Codex, Codex Harness, OpenCode, DeepSeek Harness, Kimi and Qwen use a Runner-owned task controller when goal mode is selected or a desktop message explicitly requests continuous completion. Pi's existing controller is unchanged. Ordinary questions and instructions without this request keep their existing turn behavior.

Output truncation, context recovery and task completion remain separate decisions. Only typed output-limit receipts can trigger output recovery; authentication, transport, permission and unknown tool outcomes cannot. Goal-owned DeepSeek turns disable the bridge's inner output retry loop so a new process cannot multiply retries. The task record retains at most two output recoveries, with new successful tool progress required for the second. Context recovery retains its own counters and may compact or relay the native session while retaining the SoduWork conversation and workspace.

After a successful work turn, a separate review turn checks actual artifacts and verification results. A fresh structured receipt, successful tool evidence from that review and any declared output checks are required before completion. The receipt is a model-assisted review, not a proof of arbitrary business requirements. Missing, malformed or unsupported evidence pauses the task. Two turns without new successful tool progress also pause it. Original permissions and approval requirements still apply.

The default goal budget is 240 minutes and 1,000 tool steps. Elapsed active time, tool steps, review state and recovery counters persist through internal continuations and Runner restart. Pausing does not consume active time; resuming does not replenish budgets. User messages take precedence at native turn boundaries. Stop and disable controls prevent automatic restart, including while the host is settling. Closing goal mode preserves the files and permits ordinary conversation.

Run `python3 -m unittest test_local_task_goal test_local_task_goal_integration test_context_recovery test_acp_error_messages` for the controller and boundary regressions. These checks use synthetic receipts and isolated processes; they do not establish completion quality for every real model.

With an existing compatible DeepSeek installation, run `python3 e2e_task_goal_dsh.py --adapter-entry /absolute/adapter/dist/bin.js --runtime-root /absolute/runner/data/agent-runtimes/dsh-host --node /absolute/path/to/node --output /absolute/evidence/directory`. This runs the installed adapter, runtime, real file tools and production stream/controller/resume code. A loopback model and a process-scheduling callback are test substitutes. It requires truncation recovery followed by file verification in the same native session, unchanged existing files and no repeated write. It neither installs dependencies nor uses production credentials.

## OpenCode model selection on resume

Managed native OpenCode turns pass the current model explicitly. ACP turns select the exact advertised model before prompting, using the existing session ID and history. Updating the injected default alone does not change the model retained by a native session. Missing routes or an unconfirmed model change stop the turn; the adapter does not restore old credentials, rename models, or create a replacement session.

Run `SODUWORK_TEST_OPENCODE_BIN=/absolute/path/to/opencode python3 -m unittest test_opencode_native_model_selection` with the backend test dependencies to verify native and ACP model changes against loopback endpoints. The test uses isolated native state and synthetic credentials, and checks retained history, model IDs, and credential rotation over three turns. It does not exercise a production provider or desktop UI.

## Requirement automation drafts

An authorized manager of an unarchived requirement can copy its public content into an independent automation draft. Opening or canceling the form creates nothing. Saving always creates a disabled schedule and never changes the source requirement, its version, or its existing automation link. Later schedule edits and enabling are independent of the requirement.

`POST /api/v1/schedules` accepts `sourceRequirement: {id, requirementVersion}` and a stable `creationRequestId` for this path. Hub checks current management access, archive state and the expected version, then stores a server-derived `source_requirement` snapshot of the source ID, public title and version. The response exposes these three fields as `sourceRequirement`; ordinary schedule edits cannot replace them, and provenance grants no additional task access. No execution routing, credentials or local model references are copied.

Repeating the same creation request for the same account and device returns its existing schedule. Reusing its ID with different content returns 409. This also recovers a lost response after the source changes. Migration `0088_schedule_requirement_source` adds an empty JSON default for existing schedules; it does not infer historical sources or rewrite old links.

## Managed ACP state directories

Codex Harness, Qwen, Kimi and DeepSeek Harness use private state directories under the Runner data root. If a directory cannot be created because of permissions, a conflicting file or storage failure, preparation rejects the turn before launching an executor. The client receives an actionable diagnostic without personal paths or filesystem exception contents. Inherited personal state remains untouched; repairing the directory allows a new dispatch through the normal admission checks.

`python3 -m unittest test_acp_home_isolation` checks real file collisions, injected permission failures, and Runner admission through a real subprocess/ACP bridge with a synthetic vendor. It verifies that failed preparation launches no executor and that a repaired directory permits execution. This does not establish real-provider or native-platform acceptance.

## ACP file and Kimi question contracts

ACP `fs/read_text_file` returns the complete UTF-8 file when `limit` is omitted, preserving line endings. Explicit positive `line`/`limit` values select a range. Files over the 4 MB host limit fail explicitly; the bridge never returns a silently truncated file that a native edit could write back.

Kimi's `AskUserQuestion` permission fallback is presented as answer choices. The selected `optionId` travels through the desktop and Runner unchanged; full access still waits for a human answer, and cancelling does not grant or deny subsequent tool operations. This fallback retains Kimi's first-question, single-choice behavior; the client does not advertise elicitation forms. A managed Kimi model explicitly marked `localOnly: true` may omit its API key: the launch environment receives a fixed non-secret placeholder required by Kimi, without changing saved credentials or remote-model validation.

Offline regressions run with `python3 -m smoke.smoke_acp_runtime`, `python3 -m smoke.smoke_access_policy`, and `python3 -m unittest tests.test_cli_runtime_compatibility`. They cover whole-file edit/append, question selection/cancellation and local model environment construction. Real Kimi Code 2.6.2 was also checked against a loopback model fixture; this verifies the native ACP behavior, not acceptance by an external model provider.

## Private DeepSeek Harness probe

Private model tests isolate writable DSH state and temporary files while resolving `DSH_PATH` from the Runner's installed runtime directory. Relocating test state must not relocate installed code. The private job and its raw provider output remain unavailable through Hub job APIs.

With backend test dependencies and an existing compatible DSH installation, run:

```sh
python3 e2e_dsh_private_probe.py \
  --adapter-entry /absolute/npm/root/@openma/deepseek-harness-acp/dist/bin.js \
  --runtime-root /absolute/runner/data/agent-runtimes/dsh-host \
  --node /absolute/path/to/node \
  --output /absolute/evidence/directory
```

This explicit check uses the production private-probe job and ACP bridge, the installed adapter and host, and a synthetic loopback model. It first reproduces the old incorrect installation path, then requires a real model request and the expected Agent response with the corrected path. It uses disposable home, state and temporary directories, blocks non-loopback Node connections and cleans up its subprocesses. It does not install or update dependencies, use real credentials, or verify desktop UI, production Hub or provider behavior. Run it separately from the offline quality gate because it requires an existing native installation.
