# SoduWork

[简体中文](../README.md) · **English**

An AI workspace for teams. Use the desktop client for conversations, collaboration, and task execution; manage members, models, and execution environments in a browser. Project-owned code is licensed by MDiRi under the [MIT license](../LICENSE). The first release distributes source code.

[Quick start](getting-started.en.md) · [Developer guide](development.en.md) · [All documentation](index.en.md) · [Contributing](contributing.en.md)

## Run it locally

1. Install [Python 3.12+](https://www.python.org/downloads/) and [Node.js 22.19+](https://nodejs.org/), then download and extract the source.
2. Choose a launcher from the source root. On first run, choose an administrator password of at least 12 characters:

   | Platform | Start the local service and desktop client |
   | --- | --- |
   | Windows | Double-click `start-desktop.cmd` |
   | macOS | Double-click `start-desktop.command`; if needed, run `chmod +x start*.command start.sh` first |
   | Linux desktop | Run `sh start.sh --desktop` |
   | Terminal | Run `python start.py --desktop`; macOS/Linux usually use `python3` |

3. Wait for dependency installation and the UI build. Sign in with `admin` and your chosen password. Configure your own model provider and required agents at **http://127.0.0.1:18989**.

First-time setup needs internet access. No database installation or `.env` file is required. Model credentials and credits are not included. Private data stays outside the source directory, and the service listens only on loopback. Keep the startup terminal open; press Ctrl+C or quit the desktop application to end the session.

For the management UI alone, run `python start.py`. To check prerequisites first, run `python start.py --check --desktop`. See the [full startup guide](getting-started.en.md) for storage, preparation mode, and troubleshooting, or [Docker self-hosting](../ops/self-host/README.en.md) for a team deployment.

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
| `.github/` | Automated checks, dependency updates, and bilingual collaboration templates | [GitHub configuration](../.github/README.md) |

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

Follow the [contribution guide](contributing.en.md) before submitting changes. Report security issues through a [private channel](security.en.md). Source integrity checks do not certify installers, containers, or every operating system.

Maintainers preparing a public repository should follow the [source distribution guide](open-source.en.md) to export the committed, manifest-checked tree. Public repositories must not inherit private development history or old tags.

[MIT license](../LICENSE) · [Third-party notices](third-party-notices.en.md) · [简体中文文档](README.md)
