# SoduWork management UI

[简体中文](README.zh-CN.md) · **English** · [Developer guide](../docs/development.en.md#management-ui)

Command examples use `sh start.sh` on macOS/Linux. On Windows, use `.\start.cmd` in PowerShell or `start.cmd` in Command Prompt with the same arguments. Standalone Python tools use `python3`; use `py` on Windows, or `python` inside an activated virtual environment.

React + Vite application for Hub administration. Entry point: `src/main.jsx`; routes and screens live under `src/`.

Manage organizations, accounts, clients, execution networks, models, capabilities, tasks, approvals, plugins, and release configuration. Hub enforces authorization; hiding a button is not an access check.

The model catalog starts with a compact service/model and live-load summary. Expand the overview for configuration, hourly metrics and request distribution; service and concurrency actions stay available while it is collapsed. Enabled services stay ahead of disabled ones, with custom services first within each group. A newly created service is temporarily brought into view; reopening restores that stable group order.

Service cards adapt from one to four columns according to the available content width. View opens model details in a dialog without resizing or rearranging the service grid. Add, discover and configure actions remain visible; enable/disable and deletion are in the More popover, with the existing deletion confirmation retained.

## Upload client installers

In **Client releases**, choose one original installer and a release channel, or
keep the current environment's default. Hub reads its version/platform, signs and
registers it automatically; no manifest or private key is supplied by the publisher.
Each upload finishes independently and new records stay disabled until enabled.
A failed upload keeps the selected file for retry. An identical upload returns the
existing record and preserves its enabled state. Beta selects a channel; it does
not turn a plain package version into a `-beta.N` build. Such packages require manual
installation. Environment administrators configure signing once as described in
the [backend guide](../hub-backend/README.md#register-client-installers).

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
