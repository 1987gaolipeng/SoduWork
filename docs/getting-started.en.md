# Run SoduWork from source

[简体中文](getting-started.md) · **English** · [Documentation](index.en.md) · [Developer guide](development.en.md)

Install [Python 3.12 or newer](https://www.python.org/downloads/) and [Node.js 22.19 or newer](https://nodejs.org/), then download and extract the source. On Windows, enable **Add Python to PATH** and reopen your terminal after installation. You do not need to create a database or edit an environment file.

## Start the local desktop workspace

| Platform | Start |
| --- | --- |
| Windows | Double-click `start-desktop.cmd` |
| macOS | Double-click `start-desktop.command`. If needed, run `chmod +x start*.command start.sh` first. |
| Linux desktop | Run `sh start.sh --desktop` from the source directory. |
| Terminal | Run `python start.py --desktop` (usually `python3` on macOS/Linux). |

Choose an administrator password of at least 12 characters. Setup creates a private Python environment, installs dependencies, builds the management UI, applies migrations, and opens the desktop client. First-time downloads need internet access. Sign in with `admin` and the password you chose.

Open **http://127.0.0.1:18989** to configure your own model provider. Optional agents can be installed through Agent management. This source distribution includes neither API keys nor model credits; running the management service alone does not provide AI inference.

Keep the startup terminal open. Press Ctrl+C or quit the desktop application to stop the local session. Closing a desktop window may leave the app running in the tray. Your data remains available on the next start.

The source session uses its own desktop profile and connects to the local service it starts, including custom ports. It does not overwrite an installed client's accounts, selected team server, or history. Use a separately started client for an existing team server.

For independent source development, follow the [desktop developer guide](development.en.md#desktop-client). Its login screen can edit the Hub URL; the general settings page does not provide service-environment switching. The linked launcher connects its dedicated client to the URL of that session; restart it with the chosen port when changing the local service address.

## Check or prepare first

```sh
python start.py --check --desktop
python start.py --prepare-only --desktop
```

`--check` verifies Python and Node availability without creating data or installing anything. It does not test network access or every native desktop library. `--prepare-only` downloads dependencies and builds the UI without starting a server or requesting a password. Run again without that flag to start.

For a management service without the desktop application, run `python start.py`. On a headless Linux server, omit `--desktop`. Linux desktop mode needs a graphical login and the native libraries required by Electron; the launcher does not install operating system packages or disable the sandbox.

## Ports, storage and updates

```sh
python start.py --desktop --port 18990 --data-dir "/path/to/private/soduwork-data"
```

Use the same data directory for preparation and startup. It must be outside the source directory and either empty or already initialized by this launcher. The default service listens only on loopback. Use the [self-hosting guide](../ops/self-host/README.en.md) for team deployment with PostgreSQL, HTTPS, and backups.

| Platform | Default private data directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\SoduWork\source-service` |
| macOS | `~/Library/Application Support/SoduWork/source-service` |
| Linux | `$XDG_DATA_HOME/soduwork/source-service`, or `~/.local/share/soduwork/source-service` |

The directory contains the database, attachments, service signing key, private desktop profile, logs, and reusable dependencies. Treat the whole directory as private. Never commit it or include it in a source archive. The launcher does not inherit the checkout's `.env`, production database settings, or model credentials.

Before updating source, stop the service and back up the entire data directory. Then update the source and run the same launcher again. To roll back, restore the matching source version and data backup together. Do not delete a database to reset a forgotten password.

## Troubleshooting

- **Installation/build failed:** inspect `startup.log` in the printed data directory, fix network or proxy access, and retry the same command. Completed steps are reused.
- **Desktop failed:** inspect `desktop.log`. If Electron was not downloaded, check npm install-script policy and download access. On Linux, check desktop libraries and the graphical session. You can omit `--desktop` to use the management UI while resolving it.
- **Port occupied:** use another port with `--port`; the launcher leaves the existing service running.
- **Page unavailable after closing the terminal:** start the launcher again. Local source mode runs in the foreground.
- **Windows automation:** set `SODUWORK_NO_PAUSE=1` to return a failing exit code without waiting for a keypress. First-run automation must explicitly use `--password-stdin`; never put passwords in command arguments.

## Verify the source launcher

```sh
python -m unittest tools.dev.test_start_local
python tools/dev/verify_local_start.py
```

The second command installs dependencies in a new temporary instance and verifies real HTTP login, persistence, uploads, source downloads, and process shutdown. It does not use a production database or call a paid model. Native macOS/Linux desktop behavior must be checked on those systems; Windows-only validation is not evidence of a complete three-platform release.

On a machine with a graphical desktop, add `--desktop` to also verify native Electron readiness, the isolated local connection, and desktop cleanup after Ctrl+C and a forcibly closed launcher.
