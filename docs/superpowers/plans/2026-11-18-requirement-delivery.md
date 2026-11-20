# Requirement delivery completion implementation plan

[简体中文](2026-11-18-requirement-delivery.zh-CN.md)

> **For agentic workers:** Use superpowers:executing-plans to implement and verify each task. Independent file ownership permits parallel implementation.

**Goal:** Completed native requirements reach review, explicit manual submission, or an actionable delivery failure without silently remaining in execution.

**Architecture:** Keep Hub authoritative for acceptance. Preserve the existing account-scoped receipt queue, immutable delivery bytes, and creator-only review permission. Distinguish an explicit submission choice from its effective mode; only validated current-turn outputs can resolve automatic inference.

**Tech stack:** Electron/CommonJS, native renderer JavaScript, FastAPI/SQLAlchemy, Node test runner and Python unittest.

## Tasks

- [x] Add failing backend regressions in `hub-backend/tests/test_stage_version_and_autosubmit.py` and `hub-backend/test_conversation_turns.py`: inferred policy with a valid Markdown becomes auto; explicit and unknown legacy manual remain manual; process-only, invalid and incomplete output cannot trigger inferred review; retry does not duplicate a gate or mutate the initial choice.
- [x] Update `hub-backend/app/services/conversation_turns.py`: persist `executionSubmissionChoice` separately from `executionSubmissionMode`, accept a validated `submissionChoice` at native preparation, and resolve inference only after artifact validation. Retain existing workflow and dispatch ownership.
- [x] Add native transport tests and transmit the choice in `client/main/pi-session/task-input.js`. Preserve legacy choices and verify a new Hub acknowledges inference before execution.
- [x] Add failing delivery classifier regressions, then support JSON deliverables in `client/main/conversation/delivery-contract.js` while excluding configuration, dependencies and process evidence.
- [x] Audit completion-to-receipt persistence in `client/main/pi-session/start-receipts.cjs` and `task-input.js`. Add restart and failure tests before closing demonstrated gaps. Never infer model completion from a timeout or rerun the model to resend delivery.
- [x] Add status regressions in requirement detail tests. Show manual submission, pending synchronization and actual blockers using authoritative receipts; retain review permissions and existing repair entry points.
- [x] Check creator availability and existing assignment recovery. Expose actionable blockers without substituting an executor or administrator as reviewer.
- [x] Run focused Node/Python tests, the isolated native SDK/Hub matrix and required component checks. Run `npm test` in `client/`; inspect backend `quality_gate.py --help` before selecting backend checks.
- [x] Run root public-source, third-party, documentation and secret checks. Update paired component documentation and review only task-owned changes. Do not commit unrelated work.

## Acceptance and limits

Test Markdown/JSON, Chinese and decomposed filenames, default/explicit/legacy policy, failed commands with a successful final turn, upload outage, lost response, restart, repeat delivery and identity isolation. Capture failure must not masquerade as a completed delivery. Missing reviewers must remain visibly blocked. Native macOS/Linux execution must be reported as unverified unless actually run there.

No new scheduler, broad directory upload, automatic acceptance approval or migration of ambiguous historical manual choices is authorized by this plan.

## Verification record

Validated on Windows with synthetic accounts and disposable data. The final focused client run passed 294 tests, and the UI/localization run passed 192 tests. Backend runs passed 56 lifecycle/delivery tests and 31 final policy/creator-recovery tests. The native SDK/Hub Markdown and JSON matrices and three isolated Electron acceptance suites passed their assertions. Full `npm test` ran 9,936 tests: 9,925 passed, nine skipped, and two assertions loaded during concurrent UI changes failed; both are included in the final passing focused runs. The full suite was not rerun after those edits. Public-source, documentation, third-party and secret checks passed. Native macOS/Linux and production models were not exercised.

Submission review added a regression for an explicit file contract with unchanged prior outputs and fixed the empty-capture paths. The subsequent complete client run passed 9,928 tests with zero failures and nine platform/environment skips. The combined backend delivery and Runner-event tests passed all 129 tests. Launcher tests passed with five platform skips, and the real Electron diagnostics check passed using an isolated profile.

All 403 backend release checks passed across four native shards. After synchronizing release commit `11fa69f2`, 625 client integration tests and the isolated Electron rejected-revision delivery flow passed. The full client suite preceded this synchronization; the integration run covers both locally changed and newly upstream client test files. Public-source, layout, third-party, documentation and secret checks passed again. The strict localization audit retains the same 437 missing UI entries and 695 review entries as the synchronized release baseline, with no newly missing strings; these existing audit gaps remain open.
