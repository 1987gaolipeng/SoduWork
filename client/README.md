# SoduWork desktop client

[简体中文](README.zh-CN.md) · **English** · [Developer guide](../docs/development.en.md#desktop-client)

Command examples use `sh start.sh` on macOS/Linux. On Windows, use `.\start.cmd` in PowerShell or `start.cmd` in Command Prompt with the same arguments. Standalone Python tools use `python3`; use `py` on Windows, or `python` inside an activated virtual environment.

The desktop uses Electron and native HTML/CSS/JavaScript. The React management UI is a separate application.

Before your first message, the composer checks the selected runtime and chat model. Use the action beside a missing setting, then return to your draft. The Hub overview can open runtime and model settings in the installed desktop app. While the composer is open, it reports whether those selections are ready for the signed-in account.

## Build a different default Hub

Normal builds still default to `https://service.soduwork.ai`. To build for another
deployment, set `SODUWORK_DEFAULT_HUB_URL` to an HTTP(S) origin without credentials,
paths, queries or fragments when running `npm run build`, `npm run build:linux`,
or `npm run build:mac`. For example, on Linux:

```sh
SODUWORK_DEFAULT_HUB_URL=https://hub.example.com npm run build:linux
```

An omitted or empty setting retains the normal default. The address is embedded
before signing; runtime environment variables cannot change it. Existing saved
service selections still take precedence. App name, version, installation identity,
data directories, update trust and installer filenames stay the same.

The manual **On-demand client packages** Actions workflow accepts `default_hub_url`
and an `artifact_label` such as `cn`. Select a protected branch with the intended
version and these build tools. That version must already have a stable Release;
its verified release notes are reused in every package. It runs quality checks, signing and native installation
acceptance, then keeps environment-labelled Actions artifacts for 30 days. It does
not create a GitHub Release or deploy a Hub. Each download includes
`client-packages.json` with the default address, source commit, build run and hashes.
Keep downloads from different environments in separate directories. Deployment
uploads the original installers with signed update manifests to the selected Hub;
see [the release workflow](../.github/RELEASE.md#on-demand-client-packages).

Local library imports retain file extensions and reserve room for duplicate-name counters. For files saved by older versions, a **Check file name** hint identifies duplicate, invalid, or potentially truncated names; the hint does not mean the file contents are damaged. In the item's menu, choose **Repair file name** and confirm the full name, including the correct extension. This replaces an incorrect suffix as well as a missing one, while preserving the item's ID, contents, source, and folder. Ordinary **Rename** continues to preserve the existing extension. The repair action is available for all local files, including entries whose names were already changed manually, and is not available for remote storage.

The original extension cannot always be recovered from old metadata, so the client never guesses it or rewrites names automatically. Consult the original file or source before confirming. If the correct name is unknown, export a copy for inspection. Duplicate entries retain independent contents and can be repaired to distinct names. Repairing a name does not convert the file format or allow executables to bypass the system-open restrictions.

## Source map

| Location | Responsibility |
| --- | --- |
| `main.js`, `main/` | Application lifecycle, native windows, device identity, updates, files, and execution runtimes; overlay lifecycle is in `main/desktop-overlay.cjs` |
| `preload.js` | Restricted renderer IPC; no general Node access for pages |
| `desk.html`, `desk-boot.js` | Main workspace loading and startup |
| `index.html` | Transparent pet and shortcut overlay |
| `core/` | State, synchronization, localization, and shared utilities |
| `components/requirements/` | Requirement pool, requirement drawer, dispatch lifecycle, and shared fields |
| Other `components/` directories | Conversations, AI team, and business views; runtime selectors also live under `panels/` |
| `theme/`, `assets/`, `vendor/` | Themes, assets, and licensed renderer dependencies |
| `tests/`, `e2e/` | Unit/contract checks and Electron validation; excluded from product packaging |
| `scripts/`, `build/` | Runtime preparation and native packaging |
| `runner/`, `dist/`, `.runtime/` | Generated Runner, release packages, and runtime resources |

Conversations and task execution share the same session path: `panels-chat` → `conversationSession` → main-process IPC → `agent-runtime` → Pi or Runner. AI team assignments open the corresponding conversation. Requirement drawers expand task traces; legacy detail links resolve the same requirement rather than creating duplicate records.

Switching runtimes retains a verified inventory of previously indexed artifacts with the conversation. Historical images, documents and media remain addressable after further switches or reopening, without automatically becoming current-turn deliveries. A completed reply in the active runtime may explicitly deliver a historical result again. Reads revalidate the workspace and file version; changed files require a current validated index instead of relying on an old historical entry. Historical plugin packages and their resources are checked again before showing installation readiness. Legacy switch records without a verified inventory are not reconstructed from arbitrary message links. A preview interrupted by a concurrent switch reauthorizes the same read at most once; account changes, permission failures and file actions are not retried. Loading and failed image cards retain a readable layout at narrow widths. Run `node e2e/chat-media-error-layout.cjs /absolute/evidence/directory` to check loading, failed and retried image cards in Electron with synthetic images.

Ordinary conversations retain chat mode on every runtime, including when a message asks for phased implementation or continued work. Goal loops require an explicit goal configuration; the desktop does not infer persistent goal mode from message wording. Existing configured goals retain their pause, continue, stop and recovery controls.

History refreshes retain all observed runtime execution sources for the same conversation and account, including while the durable index catches up with live updates. An unsent runtime selection is not execution history. Run `node e2e/history-goal-intent.cjs /absolute/evidence/directory` for real Electron sidebar and goal controls with synthetic history and Runner responses; this does not call real models.

If a Runner plugin draft check cannot read its files, the conversation reports the failure and stops showing active execution. Existing files remain available and dependent queued work waits for an explicit resume. A failed final check does not replay the completed model request. Cancelling or changing permissions during the check retains the user's new control state.

Selecting the built-in Plugin Developer marks that authorized turn as plugin authoring. The message describes the reusable plugin's behavior; values that vary between uses belong in the plugin's inputs instead of triggering a one-off business task. Necessary authoring questions remain possible. A generated package must pass the existing draft checks before the conversation offers **Check and install**; installation still requires the user's confirmation. Ordinary conversations and other plugins keep their existing behavior.

When the requirement creator and executor are the same person, execution continues in the original conversation. An explicitly selected runtime or model is applied through the normal native selection transaction while retaining the conversation ID and history. Acceptance also reuses the original execution conversation. These rules apply to Pi and every other runtime; only an authoritative missing-archive result permits a new conversation. Temporary read failures, denied access, and unconfirmed runtime switches preserve the original conversation and stop submission.

The desktop rail opens the requirement pool directly. The old task board, detail chat box, and separate AI workstation conversation are retired. The [release scope](../docs/release-scope.en.md) describes the shared structure, assignment rules, and compatibility boundaries.

HTML script order defines dependencies. When splitting scripts, verify resource references, shared state, loading order, and actual Electron behavior.

Desktop Markdown keeps single tildes literal, so ranges such as `3~5` and `7~14` in one paragraph retain their separators. Use `~~text~~` for strikethrough. The shared `core/markdown.js` configuration applies to conversation history, streamed replies, read-aloud text extraction and Markdown previews; saved source text is unchanged.

Double-star bold also supports punctuation next to Chinese, Japanese and Korean text, such as `**注意：**这里` and `这是**“重点”**内容`. Code spans, code blocks, escaped stars and link destinations keep their original Markdown meaning.

Conversation automation drafts accept relative delays such as `五分钟后` (in five minutes). The execution instant is anchored to the message submission time and retained when later messages only refine the work. Missing, invalid or ambiguous times require clarification instead of defaulting to daily 18:00. Incomplete task descriptions remain drafts. Users can cancel creation, continue refining the same card, or return to ordinary chat. After creation, explicit edit requests prepare changes for confirmation and update the original schedule ID; cancelling an edit keeps the saved configuration. Disabling stops future automatic runs, while closing the card only dismisses its view. Run `node e2e/automation-sheet-layout.cjs /absolute/evidence/directory` for isolated Electron form and conversation-routing checks using synthetic parser and schedule APIs.

Unconfirmed drafts support repeated time changes. Explicit time-only messages using `后`, `之后`, `以后` or `过后`, such as `修改为10分钟以后`, update the same draft locally, even when model extraction is unavailable. Each delay uses that message's submission time, captured before asynchronous access checks, and synchronizes scheduling annotations in the title, instructions and acceptance criteria without changing unrelated business durations. Restoring the card retains the latest instant; nothing is created until confirmation.

Local draft extraction honors the model's detected output-token parameter and configured output budget, bounded by its context window. When no output budget is configured, it uses the shared 16,384-token fallback instead of a fixed 1,024-token cap. Explicit smaller native request budgets remain effective. Ordinary plugin AI calls retain their separate limits. Truncated output, including a reasoning response with no final text, reports the output limit and does not create a partial draft. Provider failures retain a safe HTTP status with separate guidance for credentials, access, endpoint/model selection, incompatible parameters, throttling and service outages; raw provider responses remain private and calls are not automatically retried. Failed refinements retain this diagnostic and the original draft. Runner readiness only checks execution prerequisites and does not confirm successful model extraction.

Native history and downloaded conversation replicas retain their account and Hub boundaries when listed, read, restored, or changed, including offline use. Unknown-owner archives require explicit import as separate read-only copies. Cached content does not grant permission to execute a requirement or cloud conversation; resolving a verified native source must preserve its original runtime, model, and permissions.

Work-form conversations show their saved runtime selection in the sidebar before execution, labelled “Selected runtime”. Selection changes and reopening preserve this icon independently of actual execution provenance. Legacy drafts without a saved selection do not infer it from their archive format. Run `node e2e/workspace-runtime-label.cjs /absolute/evidence/directory` to check draft updates, history restoration and narrow sidebar layouts in isolated Electron.

Remote notice history and receipt markers use account-scoped IndexedDB transactions and Web Locks when both browser capabilities are available. Local reminders remain in the existing localStorage cache. Migration retires a legacy snapshot only after a successful durable commit, and a failed write preserves that snapshot for retry. Environments without these capabilities keep the existing cache behavior.

Colleague message delivery/read receipts retain the original attachment list for the sender. Opening an attachment resolves its current authorized metadata for the signed-in sender or recipient. Supported text, bitmap and PDF files sent with a generic binary content type use the existing restricted native preview; text remains literal, and executable formats are not added to the system-open allowlist. Receiving or opening a file does not automatically save it to the library.

The requirement delivery section can export one acceptance summary as Markdown through the native save dialog. Export requires execution-record access and an existing fixed delivery version. It reads one consistent snapshot, separates current requirement text from recorded acceptance criteria, and leaves missing validation or runtime attribution explicitly unrecorded. Exporting does not approve or change the requirement.

When a completed Pi or Runner reply explicitly links to final files without a delivery manifest, requirement delivery uses those links to select the current results. An edited intermediate file remains in the workspace and conversation history without joining acceptance inputs. Multiple linked results and their required resources remain included. Thinking, tool arguments, prose before the last tool call, internal progress messages and unfinished replies do not select final files. Explicit delivery manifests retain their complete-set and replacement semantics; version-like filenames alone do not replace older files.

Run `node e2e/run-requirements-isolated.cjs /absolute/evidence/directory /path/to/test/python requirements-rework-renamed` from `client/` to verify ordinary rejected revisions through production capture, an isolated Hub, acceptance inputs and Electron requirement details. The Python environment needs backend test dependencies. File generation is deterministic; this check does not call a real model.

The same section has a collapsed dispatch-instructions history. New desktop dispatches retain the explicitly entered supplementary note and selected/effective submission policy for each admitted conversation turn, including failed attempts. Native, Runner and workflow execution share this receipt path. Retrying the same turn cannot replace its note; later turns retain separate records. Only existing execution viewers can read this history. Old clients and historical entries without an explicit snapshot show missing fields as unrecorded; chat text, truncated legacy context and current routing are never used to reconstruct them.

Conversation analysis and automatic acceptance include the saved requirement, dispatch supplements and review rejection notes. Conflicting business requirements follow the latest recorded time; unrelated requirements remain effective. Unknown or identical timestamps require explicit clarification rather than an invented priority. Generated drafts retain the original timestamps when resent. New reviewer notes are carried separately, and changed history invalidates a prepared review. The fixed delivery version, criterion identifiers and approval permissions remain authoritative. Client and Hub must both be updated to load this history; older services explicitly report missing history. Oversized history is rejected rather than silently truncated.

Runner conversations distinguish queue waiting, execution-environment startup and actual execution. The queue shows its ordinal position and wait time; execution time starts from the native process acknowledgement. A slow startup displays guidance after 90 seconds without declaring the process stopped. Queued work remains cancellable, and missing historical timestamps are displayed as unrecorded. Run `node e2e/runner-queue-status.cjs /absolute/evidence/directory` for real Electron/Chromium controls using production adapters with synthetic Runner replies. This does not call a real model or remote Hub.

Closing a conversation automation form preserves a draft card at its original position in the transcript, with **Continue editing** to restore the saved fields. Reopening the conversation retains that entry and its collapsed state. Closing or reopening a draft does not create a schedule.

## Run and verify

Model capability report v3 verifies the complete streaming tool round trip: the synthetic tool result is the last message, tool definitions remain present, and the model must return that result without another forced tool call. Older v2 tool successes require a new check; independent image and streaming evidence remains available. A passed check verifies this small request, not every production prompt or provider policy. Update both desktop and Hub, then rerun the tool capability check for existing models.

The receipt continuation omits `tool_choice`, matching the native Pi request. A generic 403 leaves that capability inconclusive and does not skip independent checks or diagnose missing credential permissions. Explicit authentication and billing failures retain their separate handling.

Hub model refusals carry an opaque `soduwork-trace` marker through JSON, SSE and native conversation summaries. Use it to correlate the Hub transport log with a validated upstream request identifier. Generic HTTP 403 means the request was rejected; it does not prove a credential-permission defect. Completed tools and files remain available, and a 403 does not trigger an automatic retry.

Transient model failures share the existing per-turn retry budget. A provider's `Retry-After` is a minimum wait: if it exceeds the remaining time budget, automatic retries stop instead of shortening that wait. Recognized billing or quota exhaustion does not retry. Completed output and tool results remain available through the existing explicit recovery flow.

Native file delivery preserves Unicode filename spelling and file bytes, including relative links inside bundles. Update the Hub together with the desktop to accept decomposed Unicode names; canonically equivalent or case-conflicting paths are rejected rather than merged. Completed Pi turn journals can recover files with preserved old modification times within the existing scan limits; unrelated historical files remain excluded. Capture checks recorded content hashes before freezing bytes. An explicit file-path contract with no captured output or an incomplete inferred scan reports incomplete delivery; text-only and kind-only contracts retain their existing behavior. Completed manual submissions show that acceptance still requires submission. Transport continues to use the existing account-scoped durable receipt queue.

New native requirement executions distinguish the selected submission policy from its effective mode. The default can submit validated current-turn primary outputs for review even without a predeclared output contract; explicit and unclassified historical manual policies stay manual. Explicit default selections require an updated Hub acknowledgment. Standalone chat JSON results can be collected alongside Markdown; configuration, credentials, hidden directories and process files remain excluded from inference. Project workspaces retain their bounded result rules and explicit manifests remain authoritative.

Before completed-turn capture, the existing durable queue records a scoped pending-capture receipt. Interrupted capture is visible after restart; it never reconstructs a result from changed workspace files or reruns the model. Once captured, retries use frozen bytes and do not duplicate review requests. Requirement details distinguish pending synchronization, manual submission and delivery/reviewer blockers. A filesystem failure before any durable write is reported locally and cannot promise restart recovery. Restore an unavailable creator account or have an administrator verify missing attribution; execution permission never grants acceptance permission.

Opening a requirement from a completion notification refreshes its approval list even before the requirement board has been visited. Native file deliveries outside the repository-change workflow commit the review gate before the existing notification outbox announces it; transport retries retain the committed gate. A resumed turn can submit final files previously retained as incomplete process evidence, including receipts from older clients. Explicit manual submission stays manual. Acceptance navigation distinguishes review intent from ordinary navigation, and an older approval cannot clear the active review context. Update the desktop and Hub together for these delivery and notification fixes.

For a manual requirement-to-acceptance investigation, close the existing desktop and enable the optional local recorder before starting the source desktop. In PowerShell at the repository root:

```powershell
$env:SODUWORK_REQUIREMENT_DIAGNOSTICS_DIR = Join-Path $env:TEMP ('soduwork-requirement-diagnostics-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Write-Output $env:SODUWORK_REQUIREMENT_DIAGNOSTICS_DIR
.\start.cmd --desktop
```

Use a synthetic requirement and the same execution entry, model and submission choice as the failing case. After execution ends, wait 30 seconds, open the requirement details once, then retain all `requirement-*.jsonl` files in the printed directory and the approximate reproduction time. The files are the diagnostic export; no upload happens automatically. Confirm a `diagnostics.startup` record exists so an already-running, uninstrumented desktop is not mistaken for this run. Remove the environment variable with `Remove-Item Env:SODUWORK_REQUIREMENT_DIAGNOSTICS_DIR` before the next normal launch. Setting the variable does not change the configured Hub or account.

The recorder observes renderer task responses/events, native task binding, selected/effective submission modes, capture outcomes, delivery responses and receipt retries. Identifiers and endpoint/account correlation keys are hashed; prompts, titles, filenames, file bytes, tokens and raw errors are omitted. Each process stops recording at 5 MiB with a `diagnostics.limit` marker; use a fresh run if reached. A diagnostic write failure does not stop execution. Startup records include the local source fingerprint and Git revision when available; the running Hub revision is explicitly unknown. Renderer observations describe received state, not proof that a particular control was painted. Submission/acceptance policy and business data are unchanged.

Ordinary new chats use a fresh private working directory; the previous chat's
directory and the recent folder picker location are not inherited. Explicitly
selected project folders remain shared. Personal memory excludes automatic
runtime identity and knowledge-cutoff summaries and filters such historical
claims from injected local context. My Memory shows rendered Markdown by default,
with source editing available under Edit Markdown. Existing conversations retain
their history and working directory.

After successfully sending the first message of a new local chat or goal in an
explicitly selected working or project directory, the desktop remembers the
runtime and model used together.
Starting another conversation in that directory, or selecting it in a new draft,
restores that pair when both are available. Preferences belong to the current
Hub, account and device. Cloud execution retains its existing selection flow.
Temporary workspaces do not share directory preferences. If a saved runtime or
model is unavailable, select an available combination explicitly; automatic
fallback does not replace the saved pair. Changes to an unsent draft do not
replace the last-used selection. Codex account sessions without a verified model
selection do not save a directory preference.

For a first local session, run `sh start.sh --desktop` from the repository root. For independent development, keep Hub running and execute:

```sh
cd client
npm ci
npm start
```

Use Node.js 22.19+. A separately started client retains its own profile and Hub connection settings. See the [developer guide](../docs/development.en.md) for service addresses and profile isolation.

The root source launcher prepares both Hub and Runner dependencies in its private `venv/` and explicitly binds the generated desktop to that Python interpreter. For independent `npm start` development, activate `../hub-backend/.venv` and run `python -m pip install -r ../hub-backend/requirements-runner.txt -r ../hub-backend/requirements.txt Pillow` from `client/`. Pillow validates generated images before the desktop publishes them. Both paths execute the current backend source; do not substitute a Runner copied from an old release.

Run `npm test` for unit/contract tests and `npm run check:layout` for source boundaries. Inspect the requirements of each `e2e/` script before using it. Fixture success does not establish real-model or production acceptance.

Run `node e2e/plugin-authoring-intent.mjs /absolute/evidence/directory` to check the authorized authoring context, generated install card, and installation confirmation in isolated Electron. File generation is deterministic and does not call a real model. Run `node e2e/mate-attachment-notices.cjs /absolute/evidence/directory` with `SODUWORK_TEST_PYTHON` pointing to a Python environment containing the backend test dependencies to verify recipient previews, sender receipts, and third-party denial through an isolated three-account Hub. These checks do not send messages to real colleagues.

On Windows, `npm run test:e2e:user:isolated` runs the desktop user journeys with a fresh Electron profile, registered test account, local Hub and simulated provider. Install `hub-backend/requirements-test.txt` in `hub-backend/.venv`, or set `SODUWORK_TEST_PYTHON` to an interpreter with those dependencies. Results are written to `outputs/isolated-user-journeys/report.json`. Set `SODUWORK_JOURNEY_OUTPUT` to select a different evidence directory. To check workspace recovery alone, use `npm run test:e2e:user:isolated -- --only=UJ-09`, which also runs the task creation and assignment needed for recovery.

On Windows, the execution runtime joins a native Job Object before tools initialize. A private Windows PowerShell helper retains the job until shutdown and verifies its processes have exited, including Git Bash descendants whose intermediate Windows parent has already exited. This is lifecycle cleanup, not a security sandbox; Linux and macOS retain their existing process-tree cleanup.

Changing a Pi conversation from read-only to standard or full access rebuilds its tool selection from the configured defaults while preserving the conversation history. Standard access still requires approval for commands, and changing back to read-only removes write and command tools. Run `node --test tests/access-readonly-upgrade.test.cjs` to verify the production session driver with a loopback provider and real file and command operations.

If the model rejects a plugin draft repair, the conversation and queue retain the safe runtime error instead of replacing it with a generic package-validation error. Existing files and tool results remain available; HTTP 403 does not trigger another automatic repair. Static package diagnostics remain attached to the draft separately.

To verify summary export against a disposable authenticated Hub, run `node e2e/acceptance-summary-export.cjs /absolute/evidence/directory /path/to/test/python`. The Python environment needs the backend test dependencies. This exercises native IPC and saved bytes with injected save-dialog choices, not a real model or production account.

For models without an explicit maximum output budget, the desktop, Hub and Runner use 16384 tokens, further bounded by the configured context window. This fallback is not a detected provider limit. Set **Maximum output tokens** in **My Models**, or **Model Catalog** for organization models, to match the deployed service. Reasoning models may need a larger explicit budget to reach tool calls or a final answer. Keep the real context window separate from the output limit; do not shrink it to work around an output-budget rejection. Capability and connection tests use small requests and do not determine the maximum output limit. Provider rejections of the configured output limit identify the setting to adjust and do not trigger automatic retries. A Pi response that ends at the output limit with thinking but no answer or tool call may receive one bounded continuation within the same submission. It retains completed tool results and uses the same output budget and thinking settings, asking for a smaller next step or a concise answer. Repeated exhaustion remains incomplete and does not release queued work; cancellation and permission controls remain effective. This does not increase a provider limit or replace context compaction.

Model aliases do not identify their underlying reasoning protocol. For a service confirmed to provide GLM 5.3 or GLM 5.3 Flash, select **GLM 5.3 (always thinking)** under the model editor's advanced thinking strategy settings. The preset keeps the model ID, display name and output budget, and declares always-on Z.ai thinking with the valid low/high/max levels. An unset or disabled initial level resolves to low; explicit supported levels remain available. Recognized wire model names receive the same capability defaults; display labels never determine the protocol. An unknown alias in automatic mode is shown as service-controlled and unconfirmed. Explicitly disabling thinking for a recognized always-thinking model is rejected before execution. See the [provider's thinking documentation](https://docs.bigmodel.cn/cn/guide/capabilities/thinking) for supported settings. Changing the thinking policy does not complete a task or prove its acceptance criteria.

## Packaging

Before distributing native installers, complete the outstanding [distribution materials](../third-party/README.md) and platform acceptance.

On Windows, install `../hub-backend/requirements-runner-build.txt` in the backend build environment, then run `npm run build` or `npm run build-portable`. Packaging rebuilds the single-file Runner from `runner_main.py` and `runner.spec`. Do not reuse an old EXE as build input.

Windows packaging freezes source payloads through `scripts/payload-sources.cjs` to handle filesystems that expose different bytes to different processes. Source changes after manifest generation fail the build. Generated `.runtime/installer/payload-sources/` is not versioned. Native installer builds share resources and should run sequentially.

The interactive Windows installer offers English, Simplified Chinese, Japanese and Korean. It defaults to the Windows UI language, with English as the fallback, and lets the user choose before installation. Silent updates do not show the selector. Installer language does not overwrite the desktop's saved interface language. macOS and Linux retain their platform installation interfaces.

Windows uninstall retains local application data by default. The interactive wizard can optionally remove the current Windows account's `%APPDATA%\SoduWork` directory after a second confirmation. It displays the exact directory before deletion and refuses linked directories. External workspaces, other Windows accounts, Hub service data, and custom `SODUWORK_USER_DATA` locations are outside this cleanup. Silent uninstall and upgrades retain data; the legacy `--delete-app-data` switch is rejected so it cannot bypass confirmation.

Frozen input directories contain at most 64 files to avoid repeated compiler scans. Installation and verification share one extraction function with compression and per-file verification; the verifier documents compatibility exceptions for older installers. Installer fault-injection tests share the build directory and must also run sequentially. Before release, verify the final installer, upgrade, and rollback. Packaging excludes test files and selects only the single-file Runner executable as a Runner resource.

OpenCode is optional and is neither bundled nor downloaded during packaging. There is one lightweight build recipe. Agent identifiers, display metadata, model scope, and permissions come from the shared `../hub-backend/app/agent_catalog.json`, copied into release resources. Avoid a second renderer-owned catalog.

Agent management still detects installed OpenCode and offers explicit installation. `build-light` is retired; the normal build uses the lightweight recipe.

Organization-managed model services are read-only in My Models. Their addresses, credentials, models and capability checks are maintained through the Hub administration UI. Only personal services and device-owned services can be edited or tested from the client. Deploy both Hub and client changes for this boundary. Legacy personal overrides attached to an organization service remain stored but no longer affect its address, credentials or model catalog; organization models use the existing platform quota rules. To use personal credentials, explicitly add a separate personal service.

Device-owned models can be paired with any local managed runtime, including Pi, Qwen, OpenCode, DeepSeek Harness, Kimi and Codex Harness. The Codex account runtime keeps its own model catalog. Local Agent defaults are encrypted and scoped to the current Hub, device and account; conversations, requirement execution and local automations use these selections. New conversations, conversation composers, requirement dispatch and automation forms use the first available model when no model is selected or the selected model has been deleted. Local models precede Hub models, and valid selections remain unchanged. Existing conversation history is retained when the next turn switches to the replacement model. Local model calls do not consume Hub model allowance, but normal account and execution permissions still apply.

In Agent management, a managed runtime with no saved model, or with a deleted model, displays and tests the first available model. The list places local models before Hub models, and valid saved choices remain selected. This fallback does not rewrite the encrypted preference. An empty catalog remains unavailable; a failed secure-store read is reported rather than treated as deletion. Run `node e2e/agent-single-model-default.cjs /absolute/evidence/directory` to verify selection, deletion fallback and probe routing with real Electron UI, encrypted storage and private IPC. Hub and Runner responses in this test are synthetic; it does not call real model services.

Unattended local automations resolve the same fallback before opening their conversation, after verifying ownership of any device model mapping. They retain the saved schedule preference and use the replacement only for execution. Deploy both client and Hub changes for schedules whose saved Hub model has been removed: the Hub must allow the owning desktop to resolve that missing selection. Remote targets and account runtimes retain their existing admission rules. An unreadable or incomplete catalog is not evidence of model deletion; offline local access does not authorize replacing an unverified Hub selection.

Cloud conversations, remote dispatch and Hub-controlled workflows do not accept device-owned model references. Local Agent tests execute through the desktop's private Runner pipe and do not publish model configuration or test logs to Hub. Pi can generate images directly with a local OpenAI-compatible image model; output stays in the local workspace and accepts base64 image data or same-origin result URLs. Local video generation is not provided. Legacy automation model mappings without verifiable account ownership are retained in encrypted storage and require explicit model reselection. The local-model admission E2E exercises default selection, deletion, account isolation and quota behavior with real Electron processes and synthetic loopback services.

See [release scope](../docs/release-scope.en.md), [plugin authoring](../docs/plugin-authoring.en.md), and the [H5 SDK](sdk/README.md).
