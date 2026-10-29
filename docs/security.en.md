# Reporting security issues

[简体中文](../SECURITY.md) · **English** · [Documentation](index.en.md)

For credential exposure, authorization bypass, arbitrary code execution, or unauthorized access, avoid disclosing exploitable details in public issues. Prefer the hosting platform's private security reporting or confidential issue feature. If unavailable, first contact a repository maintainer to establish a private channel; do not send vulnerability details to an unverified address.

Include affected versions, operating system, deployment method, minimal reproduction, impact, and sanitized logs. Test in an isolated environment you control. Do not access another person's workspace, execution worker, or data. Do not upload real tokens, passwords, databases, or complete user sessions.

After confirming impact, maintainers should fix the issue on a private branch and run relevant regressions, including upgrades of existing data, permission boundaries, and failure recovery. Publish impact and upgrade guidance after the fix is released. This policy does not promise an unestablished response deadline or long-term support for old versions.

Use a dedicated Hub authentication key, enable HTTPS in production, and back up databases and file storage. Connect Runners only to trusted Hubs. Untrusted skills and plugins are not a security sandbox.

## Dependency audit record (2026-10-24)

Pi SDK is pinned to 1.4.0, with patched `undici 8.12.2` and `brace-expansion 5.0.12`. Node.js 22.19.0 or newer is required. The current runtime audit (`npm audit --omit=dev`) reports zero findings; the GitHub security workflow rejects high-severity runtime findings.

Build dependencies are also reviewed: Electron is locked to 44.9.3 and fast-uri to 3.1.9. Both full and runtime dependency audits currently report zero findings. Public installer distribution still requires the original notices and final per-platform materials listed in [third-party release materials](../third-party/README.md).

SDK upgrades require session recovery, tool budgets, cancellation, delivery, extension caching, and complete production-dependency packaging checks. Advisory data changes, so repeat audits before publishing.
