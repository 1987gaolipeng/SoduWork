# CodeBuddy Code as a local ACP Agent

[简体中文](codebuddy-acp.md) · **English** · [Documentation](README.md)

You can opt in to Tencent CodeBuddy Code through **Agent Management → Connect a new Agent runtime** (`Agent 管理 → 接入新底座`). This recipe uses the installed desktop client's existing custom ACP support. It does not add a built-in runtime or bundle Tencent software.

Use your own CodeBuddy account and credits. Do not share an account between people or use this setup to resell access; teams should arrange their own authorized accounts with the vendor. SoduWork's model allowance does not cover calls made with that account. Review the vendor's current terms before use.

## Scope and prerequisites

- An installed SoduWork desktop with the custom Agent entry point, a working Hub connection, and Node.js/npm available in the terminal used to start it.
- CodeBuddy Code **2.185.0**, installed separately below. The version is explicit so upgrades remain deliberate.
- This recipe is for **local conversations**. Custom Agents do not declare SoduWork's unified access-policy or native goal support. Their tools can change files and run commands; this is not a read-only or sandboxed configuration. Use a disposable workspace for the first conversation.
- Login happens in the vendor's own terminal UI before SoduWork starts. SoduWork's custom ACP bridge does not implement the ACP `authenticate` exchange or a CodeBuddy login/status button.

The vendor documents [`codebuddy --acp`](https://www.codebuddy.cn/docs/cli/acp) as its stdio ACP entry point. Its [installation guide](https://www.codebuddy.cn/docs/cli/installation) documents `CODEBUDDY_CONFIG_DIR` and `DISABLE_AUTOUPDATER`. Do not substitute `CODEBUDDY_HOME`.

## 1. Install into a private directory

Use a directory outside the source checkout and your project workspace. The examples reserve a separate SoduWork profile so this account configuration does not replace your usual desktop settings. That profile will require its own Hub sign-in.

Windows PowerShell:

```powershell
$codebuddyRoot = Join-Path $env:LOCALAPPDATA 'SoduWork-CodeBuddy'
$codebuddyInstall = Join-Path $codebuddyRoot 'cli'
$env:SODUWORK_USER_DATA = Join-Path $codebuddyRoot 'desktop'
$env:CODEBUDDY_CONFIG_DIR = Join-Path $env:SODUWORK_USER_DATA 'codebuddy'
$env:DISABLE_AUTOUPDATER = '1'
New-Item -ItemType Directory -Force -Path $env:CODEBUDDY_CONFIG_DIR | Out-Null
npm.cmd install --prefix "$codebuddyInstall" --save-exact @tencent-ai/codebuddy-code@2.185.0
if ($LASTEXITCODE -ne 0) { throw 'CodeBuddy installation failed' }
$codebuddyCommand = Join-Path $codebuddyInstall 'node_modules\.bin\codebuddy.cmd'
& $codebuddyCommand --version
```

macOS / Linux shell:

```sh
codebuddy_root="$HOME/.local/share/soduwork-codebuddy"
codebuddy_install="$codebuddy_root/cli"
export SODUWORK_USER_DATA="$codebuddy_root/desktop"
export CODEBUDDY_CONFIG_DIR="$SODUWORK_USER_DATA/codebuddy"
export DISABLE_AUTOUPDATER=1
mkdir -p "$CODEBUDDY_CONFIG_DIR"
npm install --prefix "$codebuddy_install" --save-exact @tencent-ai/codebuddy-code@2.185.0
codebuddy_command="$codebuddy_install/node_modules/.bin/codebuddy"
"$codebuddy_command" --version
```

Stop if installation fails or the version is not `2.185.0`. Follow the vendor's platform prerequisites if the CLI reports a missing dependency. These commands do not replace a global CodeBuddy installation. Keep the generated npm lockfile with this private installation; it is not a SoduWork source file.

## 2. Sign in, then start the desktop from the same terminal

Run `& $codebuddyCommand` in PowerShell, or `"$codebuddy_command"` in the shell. Follow the vendor's [interactive sign-in instructions](https://www.codebuddy.cn/docs/cli/quickstart), using your own account, then exit the CLI. Both login and later ACP execution must use the same `CODEBUDDY_CONFIG_DIR`. Check the account in this environment rather than assuming a login elsewhere is sufficient. Credential storage remains under the vendor's control; setting a config directory is not a guarantee of separate operating-system credential storage. Do not copy credential files into the catalog, command arguments, project, or an issue report.

Fully quit any SoduWork process using this profile before continuing. Closing its window may leave it running. A second launch only wakes the existing process and does not replace that process's environment.

From that **same terminal**, directly start the installed executable. Replace the example path with your installation's actual executable. On Windows, use the stable `SoduWork.exe` in the installation root, not a version-specific executable under `.soduwork-versions`:

```powershell
& 'C:\path\to\SoduWork.exe'
```

```sh
# macOS: use the executable inside the installed application bundle.
"/Applications/SoduWork.app/Contents/MacOS/SoduWork"
# Linux: instead run your installed executable or AppImage by its absolute path.
```

For later launches, set the same three environment variables again and directly start the executable. You do not need to reinstall or sign in each time unless the vendor session expires. A normal desktop shortcut does not inherit variables from this terminal.

**Source launcher limitation:** `start.cmd --desktop` / `sh start.sh --desktop` currently filters the CodeBuddy variables out of its child environment. Do not use those commands for this recipe or assume `--data-dir` preserves the variables.

The installed desktop passes the environment to its private Runner. Because the custom entry has no home override, CodeBuddy keeps the explicitly selected config directory. This separates configuration from other desktop profiles, not from concurrent conversations in this profile; use one account per profile and avoid concurrent CodeBuddy turns until that behavior has been verified for your version.

## 3. Register the local Agent

Open **Settings → Agent Management → Connect a new Agent runtime**. Current Chinese labels are shown below:

| Field | Value |
| --- | --- |
| Runtime name (`底座名称`) | `CodeBuddy Code` |
| Launch program (`启动程序`) | The full value of `$codebuddyCommand` or `$codebuddy_command`, without surrounding quotes |
| Arguments (`启动参数`) | `--acp` on one line |
| Model source (`模型来源`) | Use the runtime's own account and models (`使用底座自己的账号与模型`) |

Click **Save and connect** (`保存并接入`). Do not choose the SoduWork-managed model source or enter model environment mappings for this account-based setup. Registration uses the existing custom Agent catalog; there is no JSON file to patch and no `install.warn` or `runner.home` field to add by hand.

Use **Check program** (`检测程序`) to confirm executable discovery. That check does **not** validate vendor login, credits, ACP authentication, or model output. Start a new local conversation and select CodeBuddy Code to check those separately. Sending a prompt uses your vendor account and may consume credits. Before relying on it, verify a short answer, follow-up, cancellation, and file behavior in the disposable workspace. If the CLI still requires an ACP authentication exchange after terminal login, stop: the current bridge does not support that flow.

## Troubleshooting and removal

- **Program missing:** use the exact executable path from step 1. On Windows use `codebuddy.cmd`, not the PowerShell shim. Do not enter a shell command such as `cmd /c ...` in the program field.
- **Terminal login works but ACP asks for login:** confirm the desktop was fully restarted from the same environment and that both processes use the same config directory. Repeat the vendor's terminal login there. Do not attach the directory's contents to a bug report.
- **Wrong version:** run `--version` on the exact program registered in the UI. Keep `DISABLE_AUTOUPDATER=1` in both login and desktop launch environments; review and verify a new pinned version before reinstalling it.
- **Stop using the recipe:** quit this dedicated desktop and start your usual SoduWork profile without these temporary environment variables, from a fresh terminal or its normal shortcut. Existing conversations remain in the dedicated profile. Do not delete that profile as a routine way to remove an Agent; custom declarations are currently additive.

Validation of executable discovery or an unauthenticated ACP handshake is not acceptance of a signed-in conversation. Vendor authentication, paid calls, and native desktop behavior must be verified in your own environment before using this optional integration for work.
