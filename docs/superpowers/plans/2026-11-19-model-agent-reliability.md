# Model and Agent reliability implementation plan

[简体中文](2026-11-19-model-agent-reliability.zh-CN.md) · **English**

> For agentic workers: use task-by-task implementation and independent review. Keep model capability, gateway diagnostic and Agent discovery edits separate until integration.

**Goal:** Improve capability probes, model-request diagnostics and Agent installation discovery for issues 183 and 322.

**Architecture:** Verify a streaming tool-result continuation rather than infer it from independent capabilities. Resolve executable metadata from the selected installation, using bounded platform candidates. Preserve diagnostic correlation across JSON/SSE without exposing raw provider responses or credentials.

**Tech stack:** Electron/Node, Python/FastAPI, OpenAI-compatible HTTP/SSE, isolated filesystem and SQLite fixtures.

## 1. Streaming capability evidence

- [x] Add failing local and Hub tests where plain generation and standalone streaming succeed but streaming tool-result continuation is rejected.
- [x] Update `client/main/model-capability-probe.cjs` and `hub-backend/app/services/model_capability_probe.py` to retain tools, stream the receipt response and avoid forcing another call or adding a user message.
- [x] Version evidence in the paired capability contracts; old tool-call success requires rechecking, unrelated valid evidence remains available.
- [x] Run client capability/conformance tests and backend capability tests. Cover malformed/truncated SSE, cancellation, parameter negotiation and authentic receipt checking.

## 2. Installation identity and discovery

- [x] Add failed regressions for hidden nvm/Homebrew installations, multiple npm trees, stale private metadata and WindowsApps candidate shadowing.
- [x] Introduce bounded candidate discovery and selected-installation metadata helpers shared by discovery, version checks and launch entry resolution.
- [x] Preserve explicit overrides, private runtime precedence, reviewed versions, native dependency validation and user-owned installations.
- [x] Run backend Agent installation/state/compatibility tests plus the DeepSeek runtime smoke matrix, recording the simulated platform cases.

## 3. Gateway diagnostics

- [x] Reproduce neutral 403 classification and safe correlation across both JSON and SSE.
- [x] Add a Hub-generated opaque trace with a bounded upstream-request identifier retained only after validation and credential checks; never expose arbitrary provider bodies.
- [x] Preserve the trace in client error summaries without changing retry eligibility or completed-tool retention.
- [x] Verify correlation and redaction against malicious headers, credentials and HTML responses.

## 4. Integration acceptance

- [x] Update paired component documentation and register any new backend check in `quality_manifest.py`.
- [x] Run `npm test` in `client`, relevant backend tests, and root public-source, third-party, docs and secret checks.
- [x] Review all changes independently; resolve important findings before reporting completion.
- [x] Report the tested platforms and the synthetic provider request/response evidence.

## Initial verification record

Base: `709702da` (main); implementation branch: `fix-model-probes-agent-discovery-20261119`.

- Final focused client run: 204 tests passed across capability probe, contract, conformance, local storage, runtime, view, error classification and real session retry suites.
- Full `npm test` first run: 10,126 tests, 10,109 passed, 7 failed, 10 skipped. Five failures needed the existing backend interpreter supplied through `SODUWORK_TEST_PYTHON`; the two affected files subsequently passed all 13 tests. Two capability-view failures used obsolete evidence fixtures; corrected fixtures and legacy recheck presentation passed in the final 204-test run.
- Backend model/gateway suites: 103 tests, 1 skipped, no failures. Agent discovery/install/compatibility suites: 126 tests, 1 skipped, no failures. DeepSeek runtime smoke: 315 assertions passed.
- Real loopback acceptance used the production SDK, an HTTP Hub and an HTTP synthetic provider. Ordinary connection and standalone streaming passed while streaming tool receipt was rejected. The v3 probe correctly rejected tool capability; the actual session retained the written file, exposed its opaque trace and did not retry the 403.
- A real Node subprocess started a synthetic package through the selected entry despite a deliberately invalid adjacent `node.exe`; argument boundaries were preserved.
- Independent review findings were fixed and rechecked, including unrelated shim metadata, Node selection/launch mismatch, boot-cache identity and request-ID error-classification contamination.
- Public-source, third-party, paired-documentation and current-source secret checks passed. `git diff --check` passed.

Additional `tests.test_terminal_security` validation initially reproduced five Windows OpenCode home-directory fixture errors on both the implementation and clean main. Submission validation supplied temporary `HOME`, `USERPROFILE` and data directories for the affected fixtures; all 27 terminal-security tests then passed with their assertions preserved.

Native validation ran on Windows. macOS/Linux paths and dependency layouts were simulated. Deploy desktop and Hub together and rerun existing models' tool capability checks.

## Independent follow-up verification

The second investigation found and corrected additional gaps: an explicit `tool_choice: auto` made the probe differ from real Pi continuation; generic 403 classification skipped independent checks; verified-only legacy evidence differed between client and Hub; quoted/forward-slash Windows PATH entries were mishandled; Node child processes could inherit another installation; DSH native dependencies followed Python rather than the selected Node; custom wrapper and shebang bootstrap behavior could be discarded. Launch environments now bind to final command arguments, without rediscovery or global PATH mutation. Only reviewed standard npm shims and plain Node entries are rewritten; other wrappers retain their original command.

- Full client run: 10,132 tests, 10,123 passed, 9 skipped, zero failures. Subsequent focused capability/session tests passed 208 cases; locale checks passed 116; the 13 Python-backed client checks were rerun after the final launch changes and passed.
- Hub frontend build passed; all 448 frontend tests passed.
- Final expanded backend run after all corrections: 308 tests, 2 skipped, zero failures; DeepSeek runtime smoke passed 315 assertions. Process/recovery-focused validation additionally passed 146 tests with 2 skips. Source, third-party, documentation and secret checks passed.
- Client/Hub evidence projection and partial-merge comparison: 5,184 combinations, zero differences.
- Real SDK to HTTP Hub to synthetic provider: successful continuation, JSON 403 and HTML 403 all behaved as expected. The refusal cases retained completed files, preserved a safe trace and did not retry. A separate real SDK regression confirmed that omitting `tool_choice` no longer causes a false probe success.
- Independent Windows matrix: 7 scenarios passed with real filesystem lookup and real Node execution. POSIX-path virtual filesystem matrix: 8 simulated macOS and 6 simulated Linux scenarios passed, covering nvm, Homebrew/Cellar links, service PATH, multiple prefixes and broken links.
- Native-identity cases cover ARM/x64 Rosetta directions, Windows ARM/x64 and Linux glibc/musl differences. Unknown Node identities fail closed. Real worker/spool and parent-to-child Node tests verify launch identity, including concurrent independent environments and installation changes.
- The existing three-platform Runner CI matrix now runs discovery, launch identity, Node identity and native-layout checks. Its exact unit command passed locally on Windows (73 tests, 1 skipped).

Windows implementation validation used Node 22.23.1 and Python 3.13.14. Expanded backend validation uses `PYTHONUTF8=1`, matching the existing CI environment. Submission validation uses Python 3.12.10 and isolated temporary home directories for terminal-security fixtures.
