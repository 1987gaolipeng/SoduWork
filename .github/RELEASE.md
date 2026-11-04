# Public GitHub releases

## Scope and status

`ci.yml` and `security.yml` run ordinary push/PR checks and provide the shared quality gates for `release.yml`. Release branch pushes and tags do not trigger duplicate checks. Client tests run on Linux and Windows; source HTTP startup checks run on all three operating systems. The PostgreSQL job checks migrations, schema drift, backup and restore using a disposable database.

**Public release** offers three manual paths: source, Client and Hub. Currently, `PUBLIC-SOURCE.json` still sets `sourceOnly: true`, binary licensing reviews remain pending, and previous-installer baselines are empty. The source path can prepare a candidate; Client and Hub fail preflight. `SODUWORK_INTERNAL_BUILD` cannot bypass publication gates. Workflow source does not establish a successful GitHub-hosted run.

| Component | Build and acceptance | GitHub Release assets |
| --- | --- | --- |
| source | Export the committed tree; verify the file inventory, public boundary and shared quality gates | Source ZIP without Git history |
| client | Windows fresh installation, repair, upgrade and compatibility; Mac DMG, signature, restart and upgrade; installation, startup, upgrade and removal in Ubuntu 22/24 and Rocky 9 containers | Windows x64 EXE, Linux x64 DEB/RPM/tar.gz, Mac ARM64/x64 DMG: six packages |
| hub | Public self-hosting Dockerfile; disposable PostgreSQL, migrations, health/readiness, frontend assets, restart, image export and reload | Linux amd64 Docker image tar.gz |

Automated acceptance does not cover interactive Windows UAC, macOS Gatekeeper/notarization, real desktop login or customer filesystem filters. Mac packages retain ad-hoc signatures; Developer ID notarization and commercial Windows signing are not integrated. Hub acceptance uses one isolated node, without production deployment, real-model calls or browser interaction certification. Receipts record these limitations.

## Repository setup

1. Set the repository variable `PUBLIC_RELEASE_REPOSITORY` to the final public repository's `owner/name`. The workflow must exist on the default branch before its manual entry appears in Actions.
2. Protect `release/source-*`, `release/client-*` and `release/hub-*`, prohibit force pushes and restrict updates to maintainers. Protect `source-v*`, `client-v*` and `hub-v*`; prohibit moving or deleting published tags.
3. Create the `public-release` Environment in advance, configure **Required reviewers**, restrict deployment to protected release branches and disable administrator bypass. Configure self-review according to team responsibilities. Preflight checks the actual reviewer gate through the GitHub API and fails if it is missing; it does not rely on YAML to create the environment automatically.
4. Keep `GITHUB_TOKEN` read-only by default. Only the approved publication job receives `contents: write` and `actions: read`. Do not configure company credentials, cluster addresses, private registries, upload tokens or SSH keys. PR jobs receive no release credentials; these workflows do not use `pull_request_target` or self-hosted runners.
5. Allow the official checkout/setup/artifact actions pinned to commit SHAs. Artifacts are downloaded from the current run; final publication uses the candidate's immutable artifact ID. Candidates are retained for 30 days and must be approved before expiry. Expired or missing artifacts require a new candidate, not receipts borrowed from another run.

## Release procedure

1. Create `release/<component>-X.Y.Z` from reviewed public source. All four Client package/version/lock version fields must agree. Source and Hub versions are frozen by the branch and input, recorded in receipts, and also written to Hub OCI labels.
2. Manually run **Public release** on that branch with the matching component and version. Build and accept each candidate once. A source fix creates a new SHA and requires a new candidate.
3. After candidate preparation, stop at the `public-release` approval gate. For preparation-only work, do not create a formal tag or approve publication.
4. Review the receipts, create `component-vX.Y.Z` at **the same SHA**, then approve the original run. Before publishing, the workflow rechecks the remote release branch head, lightweight or annotated tag, source version, run ID, all platform receipts and file digests.
5. Create a draft Release, upload the original bytes and download each asset for verification. Publish only after all checks pass, then verify complete anonymous downloads. Never rebuild or overwrite assets. Retry only the publication job after a network failure. A draft from the same run can resume; a Release belonging to another run or containing different bytes is rejected.
6. Preserve the release branch head and tag. Merge release completion work into the public mainline while preserving history. New changes belong to a new version.

When preparing the public repository, reviewed source may be squashed into `public` without private development history, old tags or internal artifacts. The source ZIP still contains only the committed tree verified against the source manifest.

## Binary publication gates

Review and commit genuine resolution evidence for `third-party/public-release.json`: original licenses, corresponding source archives and actual artifact inventories. Then update the distribution scope in `PUBLIC-SOURCE.json` and the source manifest. Do not simply clear pending items to make CI pass.

Client also requires six entries in `tools/ci/soduwork-acceptance-baselines.json`: `windows-x64-exe`, `linux-x64-deb`, `linux-x64-rpm`, `linux-x64-tar.gz`, `macos-arm64-dmg` and `macos-x64-dmg`. Each entry includes `productName: SoduWork`, a strictly older `version`, `sha256`, and a `url` pointing to the same public GitHub repository, with optional `format`/`size`. Local paths and internal fallback downloads are rejected. The first public binary release has no previous public baseline and needs a separately reviewed first-release acceptance contract. Never substitute the candidate for an older version to claim a successful upgrade.

Hub images are delivered as Release assets. After downloading and verifying the manifest, run `docker load --input <image.tar.gz>` and configure your environment using the [self-hosting guide](../ops/self-host/README.en.md). This workflow does not push to GHCR or migrate company cluster deployment, backup schedules, domains or update services.

## Local validation

```sh
python -m unittest discover -s tools/github -p 'test_*.py'
python -m unittest tools.dev.test_source_export tools.dev.test_deploy tools.security.test_scan_secrets
python tools/github/check_public_ci.py
node --test tools/check-public-source.test.cjs tools/source-manifest.test.cjs tools/check-docs.test.cjs
node tools/check-public-source.cjs
node tools/check-source-manifest.cjs
node tools/check-docs.cjs
actionlint .github/workflows/*.yml
```

Application source changes still require full regression checks for affected modules. After adding new files to the Git index, update the manifest with `node tools/check-source-manifest.cjs --write-manifest` and verify it again. Manifest generation must not conceal unreviewed files.

Release procedures, workflow documentation and contribution templates are maintained in English.

References: [GitLab migration](https://docs.github.com/en/actions/tutorials/migrate-to-github-actions/manual-migrations/migrate-from-gitlab-cicd), [deployment environments](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments), [Actions limits](https://docs.github.com/en/actions/reference/limits).
