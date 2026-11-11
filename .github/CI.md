# GitHub workflows and checks

[Documentation](../docs/index.en.md)

Workflow documentation, release procedures, issue forms and the pull request template are maintained in English. Security reports follow the [security policy](../SECURITY.md); do not disclose exploitable details in a public issue.

`workflows/ci.yml` checks source boundaries, documentation, frontend builds, client contracts, backend offline checks, and isolated HTTP startup on Windows, macOS, and Linux. HTTP startup does not prove native Electron desktop, Docker deployment, provider OAuth, or real-model execution acceptance. Those need separate environments and evidence.

`workflows/security.yml` runs the [pinned local secret scanner](../tools/security/README.md) on the current source inventory, including tests. It does not scan private development history. Before publication, use a verified source export or squash the reviewed source into the public branch without private history.

Ordinary checks use read-only permissions, do not persist checkout credentials, and pin actions to reviewed commit SHAs. Branch pushes and pull requests run without release or production credentials. Release branch pushes and tags do not duplicate checks. See [GitHub's secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use).

`workflows/release.yml` provides manual source, Client and Hub pipelines with shared quality checks, immutable candidates and a reviewer gate. Only the final publication job receives write permission. Client and Hub publication runs only after the distribution scope, third-party release evidence and Client upgrade baselines pass preflight. See [release setup and boundaries](RELEASE.md).

Dependabot proposes updates for GitHub Actions, both npm lockfiles, and backend pip requirements. Review changes to dependency versions, license evidence, secret exceptions, and source manifests together.

These workflows must run in the target GitHub repository before their platform results can be claimed. Local Windows checks do not constitute a successful GitHub Actions run.

Runner dialogue regression checks follow the shared public model-error guidance.
Harness2 performs seven refinement calls before each executor turn: an empty
executor reply with retained planning is an incomplete response, not a successful
answer or a wholly empty turn. Tests require all seven usage events, retained
planning, no answer or tool activity, failed settlement, sanitized provider errors,
the same native session and exactly the requested number of turns.
