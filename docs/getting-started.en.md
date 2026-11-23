# Run SoduWork from source

[简体中文](getting-started.md) · **English** · [Back to README](../README.md) · [Developer guide](development.en.md)

Command examples use `sh start.sh` on macOS/Linux. On Windows, use `.\start.cmd` in PowerShell or `start.cmd` in Command Prompt with the same arguments. Standalone Python tools use `python3`; use `py` on Windows, or `python` inside an activated virtual environment.

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

4. Keep the window open while the launcher installs dependencies, builds the management UI, and prepares the desktop runtime. Initial downloads can take several minutes. Long steps print a status message about every 15 seconds. If preparation fails, check the printed `startup.log` path, fix the error, and rerun the same command.
5. After preparation succeeds, choose a **12–128 character** password for **`admin`** and confirm it. Typing is hidden. Press Enter after each entry. A mistake prompts you to try again. The launcher initializes the database and opens the client. Once the account is created, later starts use the same password.

You do not need to create a database, install Docker or Git, prepare an `.env` file, or install each project separately. First-time setup needs internet access; later starts reuse completed work.

The launcher installs both Hub and Runner dependencies in its private `venv/`, checks the Runner's Python imports, and gives the desktop that exact interpreter. You do not need a separate `hub-backend/.venv` for this entry point. If Agent management reports an incomplete source Runner environment, quit the source session and rerun the same launcher; keep the data directory intact.

npm, pip and Electron download caches from both service and desktop preparation default to `cache/npm`, `cache/pip` and `cache/electron` inside the data directory. Nonempty `npm_config_cache`, `PIP_CACHE_DIR` and `electron_config_cache` settings keep their explicit locations; these may be outside the data directory. Preparation also creates `cache/tmp` and sets `TMPDIR`, `TEMP` and `TMP` for its child processes on every platform, so downloads, unpacking and builds use the selected volume instead of the inherited system temporary directory. Your shell environment is unchanged. After stopping the launcher, you can skip `cache/` when backing up or moving the data directory; it is regenerable.

On Windows, desktop startup also prepares and verifies a private PortableGit command runtime in this instance's application copy so Agents can use Bash, Git, and common tools. No separate Git installation or WSL configuration is needed. Later starts preserve the runtime and download cache and check the tools again. If preparation fails, inspect `startup.log`, resolve the reported cause, and rerun the same launcher.

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
- The linked desktop client already points to this local service and uses a separate desktop profile. It does not overwrite an installed client's accounts, server address, or history.

Successful startup makes the application available. AI responses still require your own model service.

## Send your first AI message

If you already saved an API key, continue at step 3: add a concrete chat model, then select Pi and that model in the desktop client. Configuration happens in the browser admin console; conversations happen in the desktop client. Both must use the same Hub.

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

### Device-only model services

Local services added in the desktop's **My models** panel are encrypted in that desktop profile. Their endpoints, keys, model references, and local usage are not uploaded to Hub. Select them in a local Pi conversation; cloud execution, handoff, scheduled tasks, and Hub model defaults require a Hub-managed model. Local image/video definitions remain stored but are not offered through the Hub media proxy.

Signing in to the desktop is still required, and existing conversation and task permissions still apply. After sign-in, Hub model administration and model quotas do not control a local Pi model. The desktop connects directly to its provider. Ordinary conversation directory synchronization continues without model configuration, references, or local usage.

Local choices and runtime transcripts use random model references. The mapping to the real model ID, label, endpoint, and credential stays in the encrypted local catalog; runtime files use placeholders. Existing structured local references migrate without changing message text or acknowledged Hub usage. Removing and re-adding a model does not silently reconnect an old conversation to the new model. This does not encrypt conversation text or files you create, and does not remove copies in external backups.

If secure storage cannot be read, the client preserves the saved configuration and asks you to resolve the storage problem. Invalid edits are rejected without replacing the previous configuration. Switching from a local model to a managed model keeps each call's usage separate.

### Conversation history after switching accounts

Recent conversations, local history, and archives show records belonging to the current account and Hub. Switching accounts or services does not delete the originals. Return to the original account and Hub to view history with verified ownership. Expired short-lived credentials still allow offline viewing under the retained, verified local owner; explicit sign-out hides that account's history.

For old Pi conversations with no ownership record, use **Archive → Import old Pi conversation** in the desktop, select a JSONL file from the local native index, and confirm creation of a read-only copy for the current account. The original stays unchanged; tool permissions and execution state are not restored. Supported Pi files must be readable in full, with a maximum of 32 MiB and 10,000 messages. Unsupported message or attachment formats are rejected rather than silently omitted. Existing foreign or conflicting ownership cannot be bypassed through this import.

Some older records identify an account but lack verifiable information about the original Hub. They remain stored but hidden; direct opening or importing explains the ownership restriction. Restoring access requires trusted evidence of the original service; the import action cannot take ownership of these records. Keep a backup of the desktop profile and do not delete or manually rewrite ownership records.

## Start again and stop

- Use the same launcher next time and sign in with the same account. Data and model settings are retained.
- Press **Ctrl+C** in the startup terminal and wait for shutdown. Closing the desktop window may only minimize it to the tray; choose Quit from the tray to exit the application.
- Do not launch a second copy. If an instance is already running, use its existing terminal and page.
- Before updating source, stop the service and back up the entire data directory and any separate desktop profile. Then update the source and run the same launcher. Do not edit the managed application copy inside the data directory.

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

`--check` is read-only: it reports prerequisites and path risks without creating test files. Passing it does not guarantee that every installation step will succeed. Then run `.\start.cmd --desktop` in PowerShell or `start.cmd --desktop` in Command Prompt (CMD). Both terminals are supported; there is no need to avoid CMD.

Path diagnostics use Chinese and English. Redirected output keeps its current encoding; characters it cannot represent are escaped so they do not interrupt startup, while the English guidance remains readable.

`sh start.sh --desktop` in Git Bash is not inherently invalid, but it finds Python through `PATH`, unlike the Windows entry point. When the Python launcher `py` is available, `start.cmd` first tries Python 3.12, then `py -3`; it uses `python` from `PATH` only when `py` is absent. Having a supported version such as Python 3.13 installed does not mean both terminals select the same interpreter.

If Python is missing or too old, check `python --version` in the original terminal and, if `py` is installed, inspect the versions and paths listed by `py -0p`. If needed, check with the full path to an installed native Windows Python 3.12+ interpreter, then start with that same interpreter after the check passes (replace the example path):

```powershell
& 'C:\Path\To\Python\python.exe' .\start.py --check --desktop
& 'C:\Path\To\Python\python.exe' .\start.py --desktop
```

Microsoft Store Python is a valid interpreter. Windows may redirect its data directory to a deeper physical path. When long paths are needed, startup tests actual file operations before copying source, creating the virtual environment, or installing dependencies. The Windows legacy 260-character path limit does not apply to macOS or Linux.

If startup reports that long paths are unavailable, enable **Win32 long paths** in Windows and reopen the launcher so it uses a new process. The launcher does not change this system setting. Keep existing data in its original directory. A short `--data-dir` is an option for a **new, separate instance**; it does not migrate existing accounts or data.

### macOS launcher permissions

Open Terminal, type `cd ` with a trailing space, drag the extracted source folder into the terminal, then press Enter. Run:

```sh
chmod +x start.command start-desktop.command start.sh
sh start.sh --desktop
```

No `sudo` is needed. Linux desktops can also use the final command. On a headless Linux server, use `sh start.sh` without `--desktop`.

### Password typing shows nothing

Hidden input is normal: no characters or asterisks appear. Press Enter when done. Passwords shorter than 12 characters or a mismatched confirmation prompt you to try again. The account is `admin`; there is no shared default password. Do not delete the database to reset a forgotten password.

### First-time password setup says stdin is not a terminal

An uninitialized instance needs an administrator password. By default, Python must recognize standard input as an interactive terminal (TTY). A visible Git Bash window does not guarantee that native Windows Python recognizes it as a TTY; pipes, redirection, or some integrated terminals can also trigger this check. This is different from hidden password input.

First try the Windows entry point from the source directory in an interactive native PowerShell or CMD window, without a pipe or input redirection. For automation or intentional non-interactive input, explicitly add `--password-stdin` and supply the initial password through protected standard input. This flag does not generate a password or reset an existing one. Do not put passwords in command arguments, scripts, or logs. Keep the existing data directory; deleting the database is unnecessary. For initial setup where dependency downloads take several minutes, automation scripts should preferably run `--prepare-only` first, then start with `--password-stdin` using the same data directory and desktop options to prevent piped input from timing out during downloads.

### Downloads are slow or setup fails

“Still running” means the installation process has not exited; it does not prove a download has succeeded. Read the failing step in the printed `startup.log` before retrying. “Disk full” means you must free space on the volume holding the data directory or an explicitly configured cache; retrying a download does not free space. Missing package versions, permission errors and other failures also need their own remedies. Check network/proxy and package download access when the log reports a connection failure. Then rerun the same launcher; completed steps are reused. Do not delete the data directory. The initial Electron download also needs internet access.

The npm registry and binary downloads use separate endpoints. Changing the npm registry mirror changes npm package downloads; it does not change the Electron or PortableGit download URLs:

| Download | Setting |
| --- | --- |
| npm packages | `npm_config_registry` or npm's `registry` configuration |
| Electron binaries | `ELECTRON_MIRROR`; see desktop troubleshooting below |
| Windows PortableGit archives | `SODUWORK_PORTABLE_GIT_MIRROR`; see mirror and offline instructions below |

#### Certificate errors during Git clone or dependency downloads

Identify which step failed first:

- **`git clone` reports schannel `0x80092012` / revocation check failure**: this is Git's certificate revocation check while obtaining the source, before the launcher runs. Check the system clock, trusted certificate chain, proxy, and access to certificate revocation services. On a managed network, ask the administrator to confirm the proxy certificate and access policy. Switching between `sh` and `cmd` launchers cannot fix cloning. Avoid setting global `http.schannelCheckRevoke=false`: it disables revocation checks and affects subsequent Git requests.
- **Electron or PortableGit downloads report certificate chain errors such as `UNABLE_TO_VERIFY_LEAF_SIGNATURE`**: check the certificate chain presented by the download endpoint and proxy. A corporate TLS proxy needs an administrator-provided trusted CA configured for the Git / Node download tool in use; Git's certificate settings are not Node's settings. Do not bypass verification with `NODE_TLS_REJECT_UNAUTHORIZED=0`. A pinned checksum for one archive does not protect every request in the installation process.
- **Only `TypeError: fetch failed` is shown**: this is a generic network error, not proof that GitHub is unreachable or that a certificate is invalid. Check the underlying error (such as `cause.code`) and download URL for the same failed step in `startup.log`, then investigate DNS, proxy, timeout, or TLS errors as appropriate.

For restricted networks, use the proxy instructions in this section, [PortableGit mirrors and offline archives](#windows-portablegit-mirrors-and-offline-archives), or the [Electron mirror instructions](#browser-works-but-desktop-does-not). If a mirror returns `404` / `403`, check the specific version, architecture, file path, and access permissions; that response does not mean all mirrors are unavailable. Keep certificate verification enabled and rerun the same launcher after correcting the configuration.

When asking for help, include the failed step, terminal type, Python / Node / Git versions, and the relevant error and underlying error code. Remove passwords, tokens, proxy credentials, and private addresses from logs first.

#### Download through a proxy

Set the proxy in the same terminal used to launch the source application. Port `7890` below is an example; replace it with your HTTP proxy's actual listening port. Keep existing `NO_PROXY` rules and bypass the proxy for the local Hub.

Windows PowerShell:

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:7890'
$env:HTTPS_PROXY = $env:HTTP_PROXY
$env:NO_PROXY = "$env:NO_PROXY,localhost,127.0.0.1,::1".TrimStart(',')
.\start.cmd --desktop
```

macOS/Linux:

```sh
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY="$HTTP_PROXY"
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}localhost,127.0.0.1,::1"
sh start.sh --desktop
```

When `HTTP_PROXY` or `HTTPS_PROXY` is present, the launcher automatically enables `ELECTRON_GET_USE_PROXY` for the Electron install subprocess. An existing explicit setting is preserved; `0`, `false`, `no`, `off`, or an empty value disables automatic proxy activation for Electron. Node download scripts read the proxy settings and `NO_PROXY` per request and work with the required Node.js 22.19+ without raising the minimum version. `ELECTRON_GET_USE_PROXY` controls Electron only, not PortableGit downloads.

#### Windows PortableGit mirrors and offline archives

A slow first download can take more than five minutes. Each additional 64 KiB of the expected archive renews the five-minute timeout. If the server sends no data for 60 seconds, the transfer times out. You can check the byte count in `startup.log`.

PortableGit downloads from the official Git for Windows release by default. To use a mirror, set `SODUWORK_PORTABLE_GIT_MIRROR` to its root URL. It must serve `<mirrorRoot>/v2.55.0.windows.4/<original-official-filename>`. The x64 filename is `PortableGit-2.55.0.4-64-bit.7z.exe`; arm64 uses `PortableGit-2.55.0.4-arm64.7z.exe`. Confirm that your mirror provides the pinned version and target architecture; no default PortableGit mirror is configured.

Replace the example URL below with a mirror you can access:

```powershell
$env:SODUWORK_PORTABLE_GIT_MIRROR = 'https://mirror.example/portable-git'
.\start.cmd --desktop
```

The downloader tries the configured mirror first, then falls back to the official URL on failure. If only mirror access is permitted, also set `$env:SODUWORK_RUNTIME_MIRROR_ONLY = '1'` before starting to prohibit official fallback. Mirrored files must still match the project's pinned SHA-256; a different version cannot be substituted. `ELECTRON_MIRROR` applies only to Electron and is not used as a Git mirror.

You can also obtain the official archive with the matching version, architecture, and checksum in advance and supply its local path, for example on x64:

```powershell
$env:SODUWORK_PORTABLE_GIT_ARCHIVE = 'C:\Downloads\PortableGit-2.55.0.4-64-bit.7z.exe'
.\start.cmd --desktop
```

The preparation script only reads and verifies this archive; it does not modify, delete, or replace it with a download. A missing file or SHA-256 mismatch is an error: correct the path or obtain the matching archive before retrying. This offline setting covers PortableGit only; other dependencies that have not been installed still need an accessible download source.

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

The Electron binary download has a ten-minute limit. If it times out, configure a proxy as described above or choose a reachable mirror specifically for Electron, then rerun the same launcher. The npm registry mirror does not control this binary download. For example, set the Electron mirror for your shell before starting.

macOS/Linux:

```sh
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ sh start.sh --desktop
```

Windows PowerShell:

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
.\start.cmd --desktop
```

Windows Command Prompt:

```bat
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
start.cmd --desktop
```

Existing `ELECTRON_MIRROR` and proxy settings are passed to the installer, which verifies download checksums. This mirror setting affects Electron only; Windows PortableGit uses the separate settings above. Slow connections can set `ELECTRON_DOWNLOAD_TIMEOUT` to a larger number of seconds. Successfully installed dependencies are reused on the next attempt.

Check `desktop.log` in the same data directory. Resolve Electron download problems and retry. Linux desktop mode requires a graphical session and Electron's native libraries, such as NSS, GTK, and X11/Wayland. The launcher does not disable the sandbox or install operating system packages.

### Linux installation and secure sign-in

Install `.deb` or `.rpm` packages through your distribution's software installer, or use `apt install ./package.deb` / `dnf install ./package.rpm`, so the package manager resolves dependencies. Packages declare D-Bus, libsecret, and alternative GNOME Keyring / KWallet service dependencies. An existing matching service satisfies the dependency without replacing the user's keyring. The `tar.gz` and source modes do not manage system dependencies; launch them from a graphical desktop session.

Start the application as the ordinary user logged into that desktop. First access may show the system's keyring creation or unlock dialog; use a protected keyring. Do not choose an empty password or disable the sandbox to bypass startup errors. If the keyring is locked or its service is temporarily unavailable, preserve the existing device credentials, restore the system service, then fully quit and reopen the application. Do not delete `device-auth.json`, remove keyring items, or convert credentials to plaintext.

On a profile without existing device credentials, if the system keyring is unavailable, SoduWork offers an encrypted local vault for device sign-in. Choose a separate passphrase of 12–256 characters and keep it safe. You will need it every time you start the desktop, including after installing a keyring. The passphrase stays on this computer and cannot be recovered through the Hub. Other integrations that require the system keyring still need that service.

The source launcher's Linux desktop mode rejects root users (including launches through `sudo`) before creating instance data or installing dependencies. This check also applies to `--check --desktop` and `--prepare-only --desktop`. Run `sh start.sh --desktop` in an ordinary user's graphical session; use `sh start.sh` for a headless server.

Linux installation acceptance first checks that a fresh `.deb` / `.rpm` installation supplies its credential-service dependencies, then uses an isolated real GNOME keyring to check ciphertext after first launch, restart, and upgrade. The current upgrade scenario reuses dependencies from the initial installation and does not certify that upgrading an older environment resolves newly added dependencies. Container acceptance also does not replace interactive GNOME/KDE and Wayland/X11 sign-in and unlock verification.

To use management while resolving desktop setup, double-click `start.cmd` on Windows or `start.command` on macOS, or run `sh start.sh` on Linux. The browser management UI is for configuration; it is not the desktop AI conversation workspace.

### macOS Keychain and desktop identity

If Git reports an unfinished rebase or merge, finish or safely abort that operation before starting. An intermediate checkout can temporarily restore an older launcher, including its former Keychain and Electron branding behavior. Run `git status` and confirm your intended branch is checked out. Stop the previous source session, then rerun `sh start.sh --desktop`; a running client continues using its previous application copy until restarted.

Source desktop startup prepares a separate cached `SoduWork.app` with the product name and icon. It keeps the development profile separate and does not modify the installed client or the downloaded Electron bundle. This local development bundle uses ad-hoc signing; it is not a signed and notarized release installer.

The macOS desktop retains your operating-system home so it can access the default Keychain. Its application data and workspace remain separate from the installed client, and the local Hub still uses an isolated home and database.

If the default macOS Keychain is missing, startup shows a recovery page before opening the normal workspace. Use **Open Keychain Access** to inspect the login/default Keychain, then quit and restart SoduWork after correcting the system settings. If access is denied or cancelled, the login page reports the secure-storage failure and preserves existing credentials. SoduWork does not reset Keychains or fall back to plaintext storage. Only reset a Keychain when advised by [Apple Support](https://support.apple.com/guide/keychain-access/kyca2429/mac).

### Page stops working after closing the terminal

The local service has stopped. Run the same launcher again; your data remains available.

## Optional commands

Run these from the source root. The table uses the macOS/Linux wrapper. Windows PowerShell uses `.\start.cmd` with the same arguments, and Command Prompt uses `start.cmd`.

| Need | Command |
| --- | --- |
| Linked desktop startup | `sh start.sh --desktop` |
| Management service only | `sh start.sh` |
| Check prerequisites only | `sh start.sh --check --desktop` |
| Download and build without starting | `sh start.sh --prepare-only --desktop` |
| Do not open a browser automatically | `sh start.sh --desktop --no-browser` |
| Use a dedicated data directory | `sh start.sh --desktop --data-dir "D:/SoduWork-data"` |

Use the same data directory for preparation and startup. With `--password-stdin`, the launcher reads the first password only after preparation succeeds. Keep passwords out of command arguments and scripts. On Windows this mode returns immediately on failure. For other unattended invocations, set `SODUWORK_NO_PAUSE=1` to skip the keypress on failure.

For independent source development, see the [developer guide](development.en.md). The Vite proxy defaults to `http://127.0.0.1:9080`; set `SODUWORK_DEV_HUB=http://127.0.0.1:18989` when using this launcher. The default service is accessible only on this computer. For team deployment, see [Docker self-hosting](../ops/self-host/README.md).

## Ports, storage and updates

```sh
sh start.sh --desktop --port 18990 --data-dir "/path/to/private/soduwork-data"
```

Use the same data directory for preparation and startup. It must be outside the source directory and either empty or already initialized by this launcher. The default service listens only on loopback. Use the [self-hosting guide](../ops/self-host/README.md) for team deployment with PostgreSQL, HTTPS, and backups.

| Platform | Default private data directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\SoduWork\source-service` |
| macOS | `~/Library/Application Support/SoduWork/source-service` |
| Linux | `$XDG_DATA_HOME/soduwork/source-service`, or `~/.local/share/soduwork/source-service` |

On Windows, an empty or relative `LOCALAPPDATA` counts as unset and falls back to `%USERPROFILE%\AppData\Local`. Absolute `LOCALAPPDATA` values are preserved. The selected data directory must still be outside the source checkout and either empty or already initialized by this launcher.

On Linux, an unset, empty, or relative `XDG_DATA_HOME` falls back to `~/.local/share`. Absolute values, including paths with spaces, are preserved. An explicit `--data-dir` takes precedence. Existing data is not moved; use its absolute path with `--data-dir` if it was previously stored under a relative XDG directory. The source-directory safety check still applies.

The directory contains the database, attachments, service signing key, logs, and reusable dependencies. The desktop profile normally lives in `desktop-profile/` inside this directory. On macOS, data directories inside `~/Library/Application Support/SoduWork` or `soduwork` use separate desktop profiles under `~/Library/Application Support/SoduWork Development/`, outside the installed client profile. The default retains `source-service-desktop`; custom directories use `source-service-desktop-<directory-id>`, derived from the full data path. If that profile does not exist, a safe existing development profile at `source-service-desktops/<directory-id>/` is reused. When both exist, the standard profile takes precedence. Hub data and accounts stay in place; profile files are never moved or merged. Unsafe output links into installed profiles are rejected before writing files. `--check --desktop` prints the selected desktop profile without creating it. Treat the data directory and desktop profile as private. Never commit it or include it in a source archive. The launcher does not inherit the checkout's `.env`, production database settings, or model credentials.

Before upgrading an older Hub, make sure you can sign in with an administrator account whose password has 8–128 characters and includes a non-whitespace character. Reset older passwords that do not meet these requirements before upgrading, especially if the Hub has only one administrator. Users with a verified email address can also use the password reset flow. The launcher requires 12–128 characters when setting the initial administrator password.

Before updating source, stop the service and back up the entire data directory and any separate desktop profile. Then update the source and run the same launcher again. To roll back, restore the matching source version and data backup together. Do not delete a database to reset a forgotten password.

## Verify the source launcher

```sh
python3 -m unittest tools.dev.test_start_local
python3 tools/dev/verify_local_start.py
```

The second command installs dependencies in a new temporary instance and verifies real HTTP login, persistence, uploads, source downloads, and process shutdown. It does not use a production database or call a paid model. Native macOS/Linux desktop behavior must be checked on those systems; Windows-only validation is not evidence of a complete three-platform release.

On a machine with a graphical desktop, add `--desktop` to also verify native Electron readiness, the isolated local connection, and desktop cleanup after Ctrl+C and a forcibly closed launcher.

On macOS, run `TMPDIR=/private/tmp python3 tools/dev/verify_source_runner.py` with Node.js 22 on `PATH` and a test Python 3.12+ containing `websockets`. It creates a temporary Hub, desktop profile, and real Runner, signs in with a synthetic account, and checks Agent discovery without creating tasks or calling models. Chromium uses a mock Keychain for this fixture; it does not verify native Keychain access.

For desktop connection and sign-in regression checks, run `node e2e/hub-connection.cjs` from `client`. It uses an isolated Electron profile, OS-encrypted storage, and two temporary HTTP fixtures to check offline address editing, sign-in, identity isolation on switching, returning to the original service, and reopening. Screenshots and reports are written to `outputs/hub-connection/`. It does not connect to an existing service or call a model. This check is also included in `npm run test:e2e:local`.
