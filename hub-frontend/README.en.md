# SoduWork management UI

[简体中文](README.md) · **English** · [Developer guide](../docs/development.en.md#management-ui)

React + Vite application for Hub administration. Entry point: `src/main.jsx`; routes and screens live under `src/`.

Manage organizations, accounts, clients, execution networks, models, capabilities, tasks, approvals, plugins, and release configuration. Hub enforces authorization; hiding a button is not an access check.

## Develop

The simplest setup is to run `python start.py` at the repository root in one terminal, then start Vite in another.

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
