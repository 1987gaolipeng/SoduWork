# Run SoduWork from source

[简体中文](getting-started.md) · **English** · [Back to README](../README.md) · [Developer guide](development.en.md)

Your first run has four steps: install the prerequisites, extract the source, start, and sign in. This launcher runs the Hub service, browser management UI, and desktop client on your computer with a private SQLite database. No separate server is needed.

## Install, extract and start

1. Install [Python 3.12 or newer](https://www.python.org/downloads/) and [Node.js 22.19 or newer](https://nodejs.org/). On Windows, enable **Add Python to PATH**. Keep the default Node installation options, including npm. Close old terminals after installation.
2. Download the source ZIP and **extract all files** into a normal folder you can write to, such as `C:/SoduWork`. Avoid system application directories; do not run files from inside the ZIP.
3. Open the folder containing `README.md`, `start.py`, and `client`, then use your platform's launcher:

   | Platform | Default entry point |
   | --- | --- |
   | Windows | Double-click `start-desktop.cmd` |
   | macOS | Double-click `start-desktop.command` |
   | Linux desktop | Open a terminal in this folder and run `sh start.sh --desktop` |

4. On first run, choose your own password for **`admin`**, using **12–128 characters**, then confirm it. Typing is hidden: no characters or asterisks appear. Press Enter after typing. A mistake prompts you to try again without closing the window. Later starts keep the existing password.
5. Keep the window open. The launcher installs dependencies, builds the management UI, prepares the database, and opens the client. Initial downloads can take several minutes. Long steps print a status message about every 15 seconds; the printed `startup.log` path contains the details.

You do not need to create a database, install Docker or Git, prepare an `.env` file, or install each project separately. First-time setup needs internet access; later starts reuse completed work.

## Know when startup is complete

The terminal prints these key lines (use the actual address shown):

```text
SoduWork is ready: http://127.0.0.1:18989
Administrator: admin
```

The browser and desktop client then open:

- The browser starts on an introduction page. Click **Enter admin console** to reach sign-in. You do not need to download another client from this page.
- Sign in to both interfaces with **`admin` and the password you just chose**. This account belongs to your local instance, not an online service. No additional registration is needed.
- If the browser does not open automatically, visit [http://127.0.0.1:18989](http://127.0.0.1:18989). If you change the port, use the new address printed by the launcher.
- The linked desktop client already points to this local service and uses a separate `desktop-profile/`. It does not overwrite an installed client's accounts, server address, or history.

Successful startup makes the application available. AI responses still require your own model service.

## Send your first AI message

Have your provider's **API base URL, API key, and model ID** ready. These come from your model provider; the local administrator password cannot replace an API key. Real model calls may incur provider charges.

1. Sign in to the browser management UI, open **Capabilities → Model catalog**, and choose **Connect a service**. In the Chinese UI these are **能力配置 → 模型目录 → 接一个服务**.
2. Fill in and save the service details:

   | Field | What to enter |
   | --- | --- |
   | Identifier | Your own identifier, such as `my-provider` |
   | Name | A recognizable display name, such as “My model service” |
   | Protocol | Follow your provider's instructions; choose OpenAI-compatible only if the service supports that interface |
   | API URL | The provider's base URL; OpenAI-compatible services often include `/v1`. Do not enter the full `/chat/completions` endpoint |
   | API key | Your own service key; leave it empty only when the service requires no authentication |

3. On the service card, choose **Add model** (**加模型**), enter the provider's exact model ID, select **Chat model** (**对话模型**), and save. A custom display name is not the model ID.
4. Return to the desktop client, open a new conversation, and select a **ready execution agent** and the new model. If the agent needs installation or sign-in, follow its setup prompt first. You do not need a remote computer or cloud Runner for your first local conversation.
5. Send “Hello, briefly explain what you can help me do.” A real reply confirms that the AI request path works.

If the model is missing, refresh the catalog or reopen the desktop model selector, then check that both interfaces connect to the same service address. For `401/403`, check the model key and access permissions; for `404`, check the API URL, model ID, and protocol. You can explore the management UI before connecting a model service.

## Start again and stop

- Use the same launcher next time and sign in with the same account. Data and model settings are retained.
- Press **Ctrl+C** in the startup terminal and wait for shutdown. Closing the desktop window may only minimize it to the tray; choose Quit from the tray to exit the application.
- Do not launch a second copy. If an instance is already running, use its existing terminal and page.
- Before updating source, stop the service and back up the entire data directory. Then update the source and run the same launcher. Do not edit the managed application copy inside the data directory.

## Troubleshooting

### Windows launcher does not start

Read the last lines in the window. If Python or Node is missing, install it using the links above and reopen the launcher. Failures normally keep the window open so you can read the error.

If the window still closes immediately, right-click an empty area in the extracted source folder, choose Open in Terminal, and run:

```powershell
.\start-desktop.cmd
```

To check prerequisites without installing anything:

```powershell
.\start.cmd --check --desktop
```

### macOS launcher permissions

Open Terminal, type `cd ` with a trailing space, drag the extracted source folder into the terminal, then press Enter. Run:

```sh
chmod +x start.command start-desktop.command start.sh
sh start.sh --desktop
```

No `sudo` is needed. Linux desktops can also use the final command. On a headless Linux server, use `sh start.sh` without `--desktop`.

### Password typing shows nothing

Hidden input is normal: no characters or asterisks appear. Press Enter when done. Passwords shorter than 12 characters or a mismatched confirmation prompt you to try again. The account is `admin`; there is no shared default password. Do not delete the database to reset a forgotten password.

### Downloads are slow or setup fails

“Still running” means the installation process has not exited; it does not prove a download has succeeded. Read the printed `startup.log`, check network/proxy and npm/Python package download access, then rerun the same launcher. Do not delete the data directory. The initial Electron download also needs internet access.

### Port already in use

Do not stop an unfamiliar process. Use a free port from a terminal in the source directory, for example:

```powershell
# Windows
.\start-desktop.cmd --port 18990
```

```sh
# macOS / Linux
sh start.sh --desktop --port 18990
```

The browser address becomes `http://127.0.0.1:18990`, and the linked desktop client uses that address automatically. If this port is also occupied, choose another free port.

### Browser works but desktop does not

Check `desktop.log` in the same data directory. Resolve Electron download problems and retry. Linux desktop mode requires a graphical session and Electron's native libraries, such as NSS, GTK, and X11/Wayland. The launcher does not disable the sandbox or install operating system packages.

To use management while resolving desktop setup, double-click `start.cmd` on Windows or `start.command` on macOS, or run `sh start.sh` on Linux. The browser management UI is for configuration; it is not the desktop AI conversation workspace.

### Page stops working after closing the terminal

The local service has stopped. Run the same launcher again; your data remains available.

## Optional commands

Run these from the source root. On macOS/Linux, use `python3` instead of `python`, or use `sh start.sh`:

| Need | Command |
| --- | --- |
| Linked desktop startup | `python start.py --desktop` |
| Management service only | `python start.py` |
| Check prerequisites only | `python start.py --check --desktop` |
| Download and build without starting | `python start.py --prepare-only --desktop` |
| Do not open a browser automatically | `python start.py --desktop --no-browser` |
| Use a dedicated data directory | `python start.py --desktop --data-dir "D:/SoduWork-data"` |

Use the same data directory for preparation and startup. Automation may explicitly use `--password-stdin` for the first password; never put passwords in command arguments or scripts. On Windows, set `SODUWORK_NO_PAUSE=1` to return a failing exit code without waiting for a keypress.

For independent source development, see the [developer guide](development.en.md). The Vite proxy defaults to `http://127.0.0.1:9080`; set `SODUWORK_DEV_HUB=http://127.0.0.1:18989` when using this launcher. The default service is accessible only on this computer. For team deployment, see [Docker self-hosting](../ops/self-host/README.en.md).

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

## Verify the source launcher

```sh
python -m unittest tools.dev.test_start_local
python tools/dev/verify_local_start.py
```

The second command installs dependencies in a new temporary instance and verifies real HTTP login, persistence, uploads, source downloads, and process shutdown. It does not use a production database or call a paid model. Native macOS/Linux desktop behavior must be checked on those systems; Windows-only validation is not evidence of a complete three-platform release.

On a machine with a graphical desktop, add `--desktop` to also verify native Electron readiness, the isolated local connection, and desktop cleanup after Ctrl+C and a forcibly closed launcher.

For desktop connection and sign-in regression checks, run `node e2e/hub-connection.cjs` from `client`. It uses an isolated Electron profile, OS-encrypted storage, and two temporary HTTP fixtures to check offline address editing, sign-in, identity isolation on switching, returning to the original service, and reopening. Screenshots and reports are written to `outputs/hub-connection/`. It does not connect to an existing service or call a model. This check is also included in `npm run test:e2e:local`.
