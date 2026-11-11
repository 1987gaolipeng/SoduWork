# Reporting security issues

[简体中文](docs/security.zh-CN.md) · **English** · [Documentation](docs/README.md)

## How to report

For credential exposure, authorization bypass, arbitrary code execution, or unauthorized access, do not post exploitable details in public issues, Discussions, or Discord.

Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([open the form](https://github.com/mdiri-ai/SoduWork/security/advisories/new)). If you can't use GitHub, email [soduwork@outlook.com](mailto:soduwork@outlook.com) with a subject starting with `[Security]`.

Include the affected version, operating system, deployment method, minimal reproduction, impact, and sanitized logs. Test in an isolated environment you control. Do not access another person's workspace, runner, or data. Do not upload real tokens, passwords, databases, or complete user sessions.

## How reports are handled

After confirming impact, maintainers fix the issue on a private branch and run relevant regressions, including upgrades of existing data, permission boundaries, and failure recovery. Impact and upgrade guidance are published after the fix ships in a release. This policy does not promise a response deadline or long-term support for old versions.

## Deployment guidance

Use a dedicated Hub authentication key, enable HTTPS in production, and back up databases and file storage. Connect runners only to trusted Hubs. Untrusted skills and plugins are not a security sandbox.

## Dependency audit record (2026-10-24)

Pi SDK is pinned to 1.4.0, with patched `undici 8.12.2` and `brace-expansion 5.0.12`. Node.js 22.19.0 or newer is required. The current runtime audit (`npm audit --omit=dev`) reports zero findings; the GitHub security workflow rejects high-severity runtime findings.

Build dependencies are also reviewed: Electron is locked to 44.9.3 and fast-uri to 3.1.9. Both full and runtime dependency audits currently report zero findings. Third-party licenses and per-platform materials shipped with installers are described in [third-party distribution materials](third-party/README.md).

SDK upgrades require session recovery, tool budgets, cancellation, delivery, extension caching, and complete production-dependency packaging checks. Advisory data changes, so repeat audits before every release.
