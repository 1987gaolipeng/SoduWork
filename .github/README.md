# GitHub collaboration and checks

[简体中文文档](../docs/README.md) · [English documentation](../docs/index.en.md)

Issue forms and the pull request template accept Chinese and English. Security reports follow [SECURITY.md](../SECURITY.md); do not disclose exploitable details in a public issue.

`workflows/ci.yml` checks source boundaries, documentation, frontend builds, client contracts, backend offline checks, and isolated HTTP startup on Windows, macOS, and Linux. HTTP startup does not prove native Electron desktop, Docker deployment, provider OAuth, or real-model execution acceptance. Those need separate environments and evidence.

`workflows/security.yml` runs the [pinned local secret scanner](../tools/security/README.md) on the current source inventory, including tests. It does not scan private development history. Before first public publication, use a clean repository initialized from the verified source export.

Workflows use read-only repository permissions, do not persist checkout credentials, and pin actions to reviewed commit SHAs. They run on push and pull requests without release or production credentials. See [GitHub's secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use).

Dependabot proposes updates for GitHub Actions, both npm lockfiles, and backend pip requirements. Review changes to dependency versions, license evidence, secret exceptions, and source manifests together.

These workflows must run in the target GitHub repository before their platform results can be claimed. Local Windows checks do not constitute a successful GitHub Actions run.
