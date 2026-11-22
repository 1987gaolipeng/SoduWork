# SoduWork management UI

[简体中文](README.zh-CN.md) · **English** · [Developer guide](../docs/development.en.md#management-ui)

Command examples use `sh start.sh` on macOS/Linux. On Windows, use `.\start.cmd` in PowerShell or `start.cmd` in Command Prompt with the same arguments. Standalone Python tools use `python3`; use `py` on Windows, or `python` inside an activated virtual environment.

React + Vite application for Hub administration. Entry point: `src/main.jsx`; routes and screens live under `src/`.

Manage organizations, accounts, clients, execution networks, models, capabilities, tasks, approvals, plugins, and release configuration. Hub enforces authorization; hiding a button is not an access check.

## Interface language

A saved language takes precedence over the first supported browser preference, with English as the final fallback. A Traditional Chinese preference currently uses Simplified Chinese and shows a notice only when that preference supplied the effective fallback. Choosing any supported language, including the displayed Simplified Chinese option, saves an explicit choice and clears the notice. Reloading respects that choice. Reading an existing profile does not rewrite its stored language tags or other settings.

The model catalog starts with a compact service/model and live-load summary. Expand the overview for configuration, hourly metrics and request distribution; service and concurrency actions stay available while it is collapsed. Enabled services stay ahead of disabled ones, with custom services first within each group. A newly created service is temporarily brought into view; reopening restores that stable group order.

Service cards adapt from one to four columns according to the available content width. View opens model details in a dialog without resizing or rearranging the service grid. Add, discover and configure actions remain visible; enable/disable and deletion are in the More popover, with the existing deletion confirmation retained.

## Handling approvals and failed runs

In Operations, open the pending human review count to see the requests in your scope. The queue shows how long each request has waited and, when your role allows, its requirement, version and remaining reviewers. A request is marked overdue at its deadline or after 24 hours if it has no deadline. An assigned reviewer can vote or transfer an eligible assignment with permission for that gate. Request and requirement creators with approval permission can withdraw pending requests. Super administrators can manage withdrawals and transfers. Withdrawing a request stops the linked gate and requires a fresh approval before work can continue. Delivery acceptance stays with the requirement creator.

Open a recent failure to inspect its requirement or the failed node's logs. After correcting the cause, operators with run permission can retry an eligible node. AI nodes using the shared model gateway can retry with another available organization model. The original attempt stays in the run history.

## Reviewing Skill access

In the capability catalog, bundled Skills show a summary in the interface language. Expand a summary to read the author's original description. Use the switch to stage a policy change. **Save access policy** lists the Skills to add and remove. It estimates the impact from active devices' Skill selections and their owners' departments. A device matching several changes counts once. Confirm to apply the policy on the next execution, or cancel to return to the draft.

## Investigating usage and cost

On **Usage and Cost**, open the anomaly count to see the original record IDs and exact token counts, including records older than the latest 30. The dashboard flags daily ledger records above one billion tokens. Exclude those records to compare the remaining trend and usage by scenario.

Open the unpriced records to check the affected models. Enter the highest applicable provider rate in USD per million tokens to estimate the cost of that usage. With a budget for the selected period, the calculator shows the share that priced USD usage and the estimated amount would consume together. The calculation is local to the page.

## Automation template dates

Templates default to **No date limits**. Clear this option to set a start date, an end date, or both. Dates are inclusive and use the template's time zone (Asia/Shanghai by default); the existing hourly, daily or weekly rhythm determines execution times within that range. Invalid dates and reversed ranges are rejected before saving.

The desktop copies these defaults into a new automation, where the user can adjust them before creation. Updating a template does not change existing automations. After the end date, no further recurring occurrences or retries are scheduled; the final eligible occurrence retains the scheduler's existing one-poll grace period. Existing tasks and records are retained. Extend an automation's own date range to resume future runs; extend the template separately for future users. Templates remain available until explicitly disabled.

## Develop

The simplest setup is to run `sh start.sh` at the repository root in one terminal, then start Vite in another.

PowerShell:

```powershell
cd hub-frontend
npm ci
$env:SODUWORK_DEV_HUB = 'http://127.0.0.1:18989'
npm run dev
```

macOS / Linux:

```sh
cd hub-frontend
npm ci
SODUWORK_DEV_HUB=http://127.0.0.1:18989 npm run dev
```

Open the Vite address, normally **http://localhost:5173**, and sign in with the account created by the root launcher.

For a direct Uvicorn backend on port 9080, omit the override. Vite proxies `/api`, `/healthz`, and `/readyz`. Direct backend bootstrap uses its private `ADMIN_USER` / `ADMIN_PASS` settings; accounts are not hardcoded in the frontend.

## Verify

```sh
node --test tests/*.test.mjs
npm run build
```

The build generates `dist/`, served by Hub or the deployment environment. Do not commit generated output, dependencies, or private configuration. Browser checks have separate scripts under `tests/`; distinguish fixtures from actual service or provider acceptance.

After building, run `node tests/run-model-catalog-layout-browser.cjs /absolute/evidence/directory` for the model catalog's four-language layout, disclosure, polling and reload-order checks. Install the client Electron dependency or set `SODUWORK_ADMIN_TEST_ELECTRON` to its executable. This uses synthetic local responses, not a real Hub or provider.
