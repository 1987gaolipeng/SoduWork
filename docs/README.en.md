# SoduWork

[简体中文](../README.zh-CN.md) · **English**

An AI workspace for teams. Use the desktop client for conversations, collaboration, and task execution; manage members, models, and execution environments in a browser. Project-owned code is licensed by MDiRi under the [MIT license](../LICENSE).

[Quick start](getting-started.en.md) · [Developer guide](development.en.md) · [All documentation](index.en.md) · [Contributing](../CONTRIBUTING.md)

## First time? Follow these four steps

**The desktop app is for conversations and tasks; the browser management UI is for models and members.** One launcher prepares the local service and opens both interfaces.

### 1. Install two prerequisites once

Install [Python 3.12+](https://www.python.org/downloads/) and [Node.js 22.19+](https://nodejs.org/). On Windows, enable **Add Python to PATH**. Keep Node's default options, including npm, and close any old terminal windows after installation.

You do not need a database installation, Docker, Git, Android Studio, an `.env` file, or a root-level `npm install`.

### 2. Extract the source and start

Download the project's source ZIP and **extract all files** into a writable folder. Open the folder containing `README.md`, `start.py`, and `client`. Do not launch from inside the ZIP.

| Your computer | Start here |
| --- | --- |
| **Windows** | Double-click **`start-desktop.cmd`** |
| **macOS** | Double-click **`start-desktop.command`**; see [permission help](getting-started.en.md#macos-launcher-permissions) if needed |
| **Linux desktop** | Open a terminal in that folder and run `sh start.sh --desktop` |

### 3. Choose a password and wait

On first run, set and confirm a **12–128 character** password for **`admin`**. **Typing is hidden: no characters or asterisks appear.** Remember your password; there is no shared default.

The launcher downloads dependencies, builds the UI, and starts the service. First setup can take several minutes depending on your network and computer. Long steps report that they are still running about every 15 seconds. Keep the terminal open and do not launch a second copy. If a step fails, fix the reported issue and run the same launcher again; completed steps are reused.

### 4. Sign in

When you see **`SoduWork is ready`**, the browser and desktop app will open in turn.

- **Management:** open [the local page](http://127.0.0.1:18989), click **Enter admin console** on the introduction page, and sign in with `admin` and your password. You do not need to download another desktop client there.
- **Desktop:** sign in with the same credentials. Its local service address is configured by the launcher.
- **AI conversations:** add your own model service in **Model catalog**, then choose a model in the desktop app. Follow [your first AI message](getting-started.en.md#send-your-first-ai-message). You can explore the UI before configuring a model; API keys and model credits are not included.

**Next time, use the same launcher and password.** Press **Ctrl+C** in its terminal to stop. Closing the desktop window can leave it running in the tray. Your data is retained, separately from any installed client's accounts or history.

For troubleshooting, alternative ports, browser-only mode, and data locations, see the [full startup guide](getting-started.en.md). For a team deployment, see [Docker self-hosting](../ops/self-host/README.en.md).

## Understand the project

```text
Desktop client: client/ ─────┐
                            ├── HTTP / WebSocket ── Hub: hub-backend/ ── Database
Admin UI: hub-frontend/ ─────┘                              │
                                               Local or separate Runner → Agent / Model
```

| Location | Responsibility | Start here |
| --- | --- | --- |
| `client/` | Electron desktop, conversations, and local execution | [Desktop development](development.en.md#desktop-client) |
| `hub-backend/` | FastAPI APIs, authorization, data, orchestration, and Runner source | [Backend development](development.en.md#hub-backend) |
| `hub-frontend/` | React + Vite administration UI | [Frontend development](development.en.md#management-ui) |
| `skills/` | Project-owned office, task, and extension instructions | [Extension development](development.en.md#skills-and-plugins) |
| `ops/self-host/` | Single-host Docker deployment and configuration | [Self-hosting](../ops/self-host/README.en.md) |
| `tools/` | Local startup, quality checks, and source export | [Development and verification](development.en.md) |
| `third-party/` | Dependency licenses and provenance | [Third-party notices](third-party-notices.en.md) |
| `docs/` | Usage, development, and distribution guides | [Documentation index](index.en.md) |
| `.github/` | Automated checks, dependency updates, and bilingual collaboration templates | [GitHub configuration](../.github/CI.md) |

Each application owns its dependencies. There is no root-level `npm install` step. The [developer guide](development.en.md) explains where to change the UI, APIs, desktop, or extensions and how to verify each change.

## Third-party open-source components

We thank these open-source projects and their contributors:

- Desktop and management UI: Electron, React, Vite.
- Services and agent execution: FastAPI, Pi SDK, Google Research Harness².
- Editing, terminals, and content rendering: CodeMirror, xterm.js, marked, highlight.js, jsdiff, diff2html, DOMPurify.

Third-party components retain their original copyrights and license notices and remain subject to their own licenses. The project's MIT license applies to project-owned material it has the right to license. This is a selection of major components; see [third-party notices](third-party-notices.en.md), [license and provenance records](../third-party/README.en.md), and the [dependency materials inventory](../third-party/manifest.json) for versions, sources, and original license texts.

The source tree and final installers may contain different components. Public installer distribution still requires missing original notices, corresponding-source archives, and final platform inventories. See [outstanding distribution materials](../third-party/README.en.md#outstanding-binary-release-work) for the current status.

## Release scope and contributions

The first release includes desktop, Hub, the management UI, Runner source, project-owned skills, and generic deployment tools. Mobile applications, third-party skill bundles, internal design records, and company-specific operations are excluded. Generic model APIs and executor compatibility, including Codex, use services and permissions supplied by the user. See [release scope](release-scope.en.md).

Follow the [contribution guide](../CONTRIBUTING.md) before submitting changes. Report security issues through a [private channel](../SECURITY.md). Source integrity checks do not certify installers, containers, or every operating system.

Maintainers preparing a public repository should follow the [source distribution guide](open-source.en.md) to export the committed, manifest-checked tree. Public repositories must not inherit private development history or old tags.

[MIT license](../LICENSE) · [Third-party notices](third-party-notices.en.md) · [简体中文文档](README.md)
