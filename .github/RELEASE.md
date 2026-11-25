# Public GitHub releases

## Scope and status

`ci.yml` and `security.yml` run ordinary push/PR checks and provide the shared quality gates for `release.yml`. Release branch pushes and tags do not trigger duplicate checks. Client tests run on Linux and Windows; source HTTP startup checks run on all three operating systems. The PostgreSQL job checks migrations, schema drift, backup and restore using a disposable database.

**Draft release** defaults to the combined Client + Hub path, with source, Client and Hub subsets for diagnostics. Client and Hub preflight fails while `PUBLIC-SOURCE.json` sets `sourceOnly: true`, any item in `third-party/public-release.json` is pending, or previous-installer baselines are missing. The source path does not depend on these gates. `SODUWORK_INTERNAL_BUILD` cannot bypass publication gates. Workflow source does not establish a successful GitHub-hosted run.

| Component | Build and acceptance | GitHub Release assets |
| --- | --- | --- |
| source | Export the committed tree; verify the file inventory, public boundary and shared quality gates | Source ZIP without Git history |
| client | Windows fresh installation, repair, upgrade and compatibility; Mac DMG, signature, restart and upgrade; installation, startup, upgrade and removal in Ubuntu 22/24, Rocky 9 and Fedora 45 containers; RPM/OpenPGP verification | Windows x64 EXE, Linux x64 DEB/RPM/tar.gz with detached signatures and public key, Mac ARM64/x64 DMG |
| hub | Shared self-hosting Dockerfile; disposable PostgreSQL, migrations, baked release identity, health/readiness, frontend assets, Pi/Codex versions, Runner entrypoint, non-root writable directories, restart, image export and reload | Linux amd64 Docker image tar.gz |

Hub release and Compose builds share `ops/self-host/Dockerfile`; the former
`Dockerfile.server` has been consolidated into it. GitHub builds the inline `deps`
stage and supplies the commit, version and intended tag as build arguments. Acceptance
checks the image's own identity without overriding it at startup. Original Pi and
Codex license snapshots are shipped under `/srv/app/third-party/licenses`, with
version-specific source references and digests in `third-party/manifest.json`.
The receipt records the CLI versions and verifies the notices are present.
These probes do not authenticate providers, enroll a Runner or execute model tasks.
The image still starts only the Hub and runs as UID/GID 10001. Existing clusters
need separate data-volume permission, database and Runner compatibility checks.

Automated acceptance does not cover interactive Windows UAC or customer filesystem filters. Public macOS builds require a Developer ID Application identity, hardened runtime, notarization and a real login Keychain smoke test. The manual package-validation workflow intentionally keeps ad-hoc signatures and mock Keychain isolation; those artifacts are never eligible for publication. Hub acceptance uses one isolated node, without production deployment, real-model calls or browser interaction certification. Receipts record these limitations.

The Intel macOS release job applies GitHub's temporary [Apple ticket networking workaround](https://github.com/actions/runner-images/issues/14924): it blocks outbound UDP port 443 on the disposable runner so ticket downloads use HTTPS over TCP. This covers both stapling and acceptance validation; notarization, signatures and ticket checks remain required. The rule is confined to that runner and is not included in the shipped client.

Before running the public Client release, configure these repository or environment secrets: `SODUWORK_MAC_CERTIFICATE_B64`, `SODUWORK_MAC_CERTIFICATE_PASSWORD`, `SODUWORK_MAC_KEYCHAIN_PASSWORD`, `SODUWORK_MAC_SIGN_IDENTITY`, `SODUWORK_MAC_NOTARY_KEY_ID`, `SODUWORK_MAC_NOTARY_ISSUER` and `SODUWORK_MAC_NOTARY_PRIVATE_KEY_B64`. The workflow imports the Developer ID certificate into an ephemeral keychain, stores the `notarytool` profile, and removes both after the job. It appends this keychain to the existing search list so the login Keychain remains accessible, then restores the original list on cleanup or a preparation failure. The release build fails closed when the identity is missing or notarization is disabled. The runner must also be logged into a disposable macOS account whose login Keychain can authorize the signed application; release acceptance sets `SODUWORK_MAC_REAL_KEYCHAIN=1` and writes synthetic ciphertext into an isolated profile and requires later restart and upgrade processes to decrypt those same bytes. Missing, corrupt or unreadable ciphertext fails acceptance instead of being replaced.

For migration from an older ad-hoc-signed macOS release, its reviewed baseline entry may explicitly set `notarization: "legacy-ad-hoc"`. Acceptance verifies its SoduWork identity, older version, exact artifact path and pinned SHA-256 before extraction, then still requires a strict bundle signature. Only that old baseline is exempt from Gatekeeper and stapled-ticket checks, and the exception is recorded in the receipt. New candidate packages always require both checks. Do not mark the candidate as a legacy baseline.

Linux releases require repository secrets `SODUWORK_LINUX_SIGNING_KEY_B64` and
`SODUWORK_LINUX_SIGNING_PASSPHRASE`, plus repository variable
`SODUWORK_LINUX_SIGNING_FINGERPRINT`. Missing credentials block the build before
dependency preparation. RPMs receive embedded OpenPGP signatures; all three Linux
formats also receive detached signatures. The exported public key and signatures
are required candidate assets and are hashed after signing. Native RPM acceptance
requires a trusted signature with `localpkg_gpgcheck=True`. See
[Linux signing setup and download verification](../docs/linux-package-verification.en.md)
for key requirements and first-install trust instructions. Standalone DEB signatures
do not provide automatic APT repository authentication.

The current 1.13.18 RPM upgrade baseline is signed and requires normal OpenPGP
verification. The older published 1.13.17 RPM predates package signing; testing
that version requires an explicit `rpmSignature: "legacy-unsigned"` baseline.
In disposable acceptance containers only, that old installer is rechecked against
its pinned SHA-256 before the signature exception is applied. The receipt records
the exception and hash. Never apply the exception to a signed baseline or a new
candidate; installation, verification and upgrade require their signatures.

## Repository setup

To validate packaging before publication approval, set `PACKAGE_VALIDATION_REPOSITORY`
to this repository's `owner/name` and manually run **Native package validation**.
It builds Windows x64, Linux x64 (DEB/RPM/tar.gz), and Mac ARM64/x64 on native
GitHub-hosted runners. Each job uploads only its build/checksum report.
Installers stay on the ephemeral runner while binary distribution review remains
pending. This workflow neither creates a Release nor supplies
upgrade-acceptance receipts to `Draft release`.

To exercise Linux signing with repository secrets before a Release, enable
`signed_linux` in **Native package validation**. This runs only the Linux build,
signs the actual installers, verifies the committed upgrade baselines and runs
the native Linux installation matrix. It uploads `signed-linux-validation` with
the installers, signatures, public key and a validation-only receipt. The ordinary
unsigned matrix is skipped in this mode. The binary scope and third-party review
must already permit distribution. This mode neither creates a Release nor emits
the protected release pipeline's `linux-receipt.json`; it can also validate a fork
against the committed upstream public baselines, always checking their pinned
digests. Publication still requires the independent protected Release workflow.

1. Set the repository variable `PUBLIC_RELEASE_REPOSITORY` to the final public repository's `owner/name`. The workflow must exist on the default branch before its manual entry appears in Actions.
2. Protect every maintained `release/X.Y.x` branch, prohibit force pushes and restrict updates to maintainers. Protect `v*`; prohibit moving or deleting published tags. A new maintenance branch must be protected before its first release workflow run.
3. Create the `public-release` Environment in advance, configure **Required reviewers**, restrict deployment to protected release branches and disable administrator bypass. Configure self-review according to team responsibilities. Preflight checks the actual reviewer gate through the GitHub API and fails if it is missing; it does not rely on YAML to create the environment automatically.
4. Keep `GITHUB_TOKEN` read-only by default. Only the draft upload job receives `contents: write` and `actions: read`. Do not configure company credentials, cluster addresses, private registries, upload tokens or SSH keys. PR jobs receive no release credentials; these workflows do not use `pull_request_target` or self-hosted runners.
5. Allow the official checkout/setup/artifact actions pinned to commit SHAs. Artifacts are downloaded from the current run; final publication uses the candidate's immutable artifact ID. Candidates are retained for 30 days and must be approved before expiry. Expired or missing artifacts require a new candidate, not receipts borrowed from another run.

## Release procedure

1. Create one long-lived `release/X.Y.x` maintenance branch for each supported minor series from reviewed public source. Reuse it for all patch releases in that series: `release/1.13.x` produces `v1.13.17`, `v1.13.18`, and later 1.13 tags. Client and Hub use the same full X.Y.Z version; the version is recorded in receipts and written to Hub OCI labels.
2. Manually run **Draft release** on that branch with the matching component and full version. The version's major and minor numbers must match the branch; version-specific branches and tag refs are rejected. Runs are serialized per maintenance branch. Keep the branch at the candidate SHA until draft upload finishes. Build and accept each candidate once; a source fix creates a new SHA and requires a new candidate.
3. The final job creates a **Draft Release only**, targeting the accepted SHA. It downloads every uploaded asset with authentication and verifies its digest. It never publishes the draft and does not require creating a formal tag first. An existing tag must point to the accepted SHA.
4. Maintainers with access to draft releases download and test the candidate internally. Draft assets are not anonymous public downloads. The workflow contains no public-publish command; publishing later requires an explicit, separate maintainer action after internal testing.
5. Keep the current version number until its Release is public. Source fixes or new mainline changes require a new candidate SHA and build for that same version; they do not advance the patch number. Never overwrite accepted assets. Retry the draft job after a network failure: a draft from the same run can resume, while another candidate or an already public Release is rejected. To replace an unpublished candidate, explicitly review and remove its obsolete draft before creating the replacement, and preserve the old candidate's recovery records and artifacts.
6. Use `component: all` to build Client and Hub together with one shared quality/security gate and one manifest. Individual components are diagnostic subsets and cannot be merged into another run's draft. Preserve the accepted SHA for the eventual `vX.Y.Z` tag.
7. Keep using the same maintenance branch after publication. Develop new features on `main`, fix bugs there first where applicable, and backport selected fixes into the supported maintenance branches. Forward-port any release-only fixes to `main`; once the branches diverge, do not merge unrelated mainline features or older release version files wholesale between them. Only after the current Release is public, bump the Client package, lockfile and renderer versions together for the next patch release. Pin the six desktop upgrade baselines to the previous public release's original asset URLs, sizes and SHA-256 digests; the baseline version must be strictly older than the new candidate.

When replacing old `release/X.Y.Z` branches, first preserve their published `vX.Y.Z` tags and verify that each branch's work is retained in `main`, the maintenance branch, or an explicitly named archive branch. Preserve unmerged work before deleting an obsolete branch. Delete only the obsolete branch refs and their exact branch-protection rules; retain the published tags, Releases, accepted assets, and active maintenance-branch protections.

When preparing the public repository, reviewed source may be squashed into `public` without private development history, old tags or internal artifacts. The source exporter creates a ZIP from the committed tree, generates its manifest from the archived bytes, and verifies the archive before returning it. The manifest is not tracked in Git.

## On-demand client packages

The normal **Draft release** workflow continues to build the AWS-default public
client and a deployment-independent Hub image. For an occasional deployment with
another default address, run **On-demand client packages** (`client-packages.yml`).
Select a protected branch containing the desired package version and these tools;
older tags without this capability cannot use it directly. For an already released
version, use a reviewed build-only branch based on that version. Record its actual
source commit; do not move the published tag or claim the modified build has the
original release's SHA. The workflow must be present on the default branch before
GitHub exposes its manual entry.

Inputs are `default_hub_url` (empty means `https://service.soduwork.ai`) and
`artifact_label` (a short lowercase label such as `cn`, used only for downloads).
It builds one environment, six desktop installers across four native jobs, reusing
the public quality, binary-review, signing and installation acceptance gates.
The existing `public-release` reviewer environment controls signing jobs. Original
installer basenames, app identities, data directories, version and update trust
remain unchanged. Native acceptance checks the installed candidate's default Hub;
existing user-selected addresses continue to take precedence. The version must
already have a stable Release with `release-manifest.json` and `release-notes.json`.
Preflight verifies both assets against their published digests, checks the notes
against the release manifest, and shares the same inputs with all native jobs.
Packages reuse the published version's notes without regenerating or publishing
them. Receipts retain both the original notes provenance and the new build identity.

Download the four `client-<version>-<label>-<shard>-<run>` artifacts from Actions
within 30 days. Each contains original installers, any Linux package signatures,
and `client-packages.json` binding the URL, source, run, native acceptance and hashes.
These are authenticated workflow downloads, not permanent public download links.
The workflow has no Release-writing permission and never changes existing Release
assets. Keep each environment's artifacts in a separate directory.

Deployment remains outside this build workflow. Reuse the official same-version
Hub image with the target environment's database, storage and service configuration.
Verify migration/rollback readiness and deploy the Hub before enabling new clients.
Verify the downloaded installer hashes, then upload one `installer` multipart file
to the target Hub's `POST /api/v1/admin/client-releases/upload`, optionally choosing
`channel=stable` or `channel=beta`. The Hub inspects, signs and registers each package
as a disabled record. Configure the environment's signing key once as described in
the [backend guide](../hub-backend/README.md#register-client-installers); publishers
do not supply a manifest. Existing offline-signed `bundle` uploads remain supported.
Review all intended platform records, then enable each with
`PATCH /api/v1/admin/client-releases/<id>` and `{"enabled": true}`. Verify public
downloads, signatures and the old client's update API. Preserve old records and
rollback evidence. Keep deployment credentials and update-signing private keys on
the deployment side; this workflow needs no Hub credentials. Same-version packages
do not trigger an automatic upgrade. Old separate CN/Global installation identities
still require the previously documented manual migration.

## User-facing release notes

For `client` and `all`, the `release-notes` job runs after preflight and before
native builds. It compares the last published desktop ancestor release with the
candidate commit, including merge commits, and sends only commit titles to the model
(no commit bodies or file lists). Reviewed `docs/releases/X.Y.Z.json`
content takes precedence; otherwise the job calls the configured OpenAI-compatible
model. Configure these repository variables under Settings → Secrets and variables
→ Actions → Variables; store the API key under Secrets:

| Variable | Meaning | Default |
| --- | --- | --- |
| `RELEASE_NOTES_API_URL` | Full HTTPS chat-completions endpoint | `https://api.openai.com/v1/chat/completions` |
| `RELEASE_NOTES_MODEL` | Provider's model ID | Required for model generation |
| `RELEASE_NOTES_API_KEY_SECRET` | Name of the GitHub Secret containing the matching key, never the key value | `RELEASE_NOTES_API_KEY` |
| `RELEASE_NOTES_TIMEOUT_SECONDS` | Network-operation timeout, integer from 1 to 600 seconds | `300` |
| `RELEASE_NOTES_MAX_TOKENS` | Output token budget including thinking, integer from 1 to 131072 | `32768` |

For an existing `OPENROUTER_API_KEY` Secret, set `RELEASE_NOTES_API_KEY_SECRET`
to `OPENROUTER_API_KEY`, `RELEASE_NOTES_API_URL` to
`https://openrouter.ai/api/v1/chat/completions`, and `RELEASE_NOTES_MODEL` to the
chosen model ID. Change the endpoint, model and secret name together when switching
providers. A missing selected Secret does not fall back to another provider's key.
A non-default Secret name requires an explicit endpoint; it never uses the
OpenAI endpoint implicitly.
Model and provider access rules still apply; a free model may be rate limited.

Empty numeric variables use their defaults. Invalid values leave generated notes
unavailable without making a model request. The request uses system/user messages,
without `reasoning_effort` or disabling thinking. Credentials are supplied only to
the generation step. Changing these variables affects new generation runs;
reruns that restore an existing artifact keep that artifact's notes.
Source-only and Hub-only diagnostic builds do not generate desktop notes.

For OpenRouter, generation requires a `:free` model or `openrouter/free`. Before
inference, the job checks the public model catalog and verifies zero pricing,
including request fees. Missing prices, conditional pricing, catalog failures,
missing models or nonzero prices leave notes empty without sending an inference
request. OpenRouter requests also set zero provider price limits for prompt,
completion and request charges. The check applies to the main, EU and US
OpenRouter endpoints; other configured services keep their existing request format.

Generation logs record the model, timing, request settings, HTTP status and a
bounded failure category. When returned, `release_notes_usage` records nonnegative
integer `prompt_tokens`, `completion_tokens`, `total_tokens` and
`completion_tokens_details.reasoning_tokens` (logged as `reasoning_tokens`). Missing
or malformed counters are omitted, not estimated; they do not affect generation.
These counters complement elapsed time without another model call. Logs never include
keys, private endpoint addresses, commit text, raw provider responses, arbitrary usage
metadata or reasoning content. Failed generation
creates a GitHub Actions warning annotation and a job summary while packaging
continues. The warning distinguishes access denial, rate limits, missing or paid
models, catalog verification failures and invalid output. When a replacement is
needed, it directs maintainers to allow a free model/provider in OpenRouter and
update the repository variable `RELEASE_NOTES_MODEL` before starting a new run.

The JSON contains Chinese, English, Japanese and Korean prose with matching
section/item IDs and commit provenance. A single model call selects up to five
title-supported changes, prioritizing data loss/overwrite/corruption fixes, broken
core workflows, everyday usability, then build/deployment options. Each item uses
one natural sentence about a main user change with at most two closely related
effects; ambiguous details are omitted rather than guessed. A short terminology
guide improves Chinese wording, such as “源码安装” for source setup. Input remains
commit titles only; the timeout and output-token limits are unchanged. The model cites
only selected commits; the tool marks the rest as `not-highlighted`, without
claiming they have no user impact. Ambiguous titles must not be expanded with
invented details. User-facing prose must describe actual
changes, without links, generic placeholders or copied release infrastructure
metadata. Model errors, timeouts and invalid generated content produce an empty
`status: unavailable` artifact and do not block packaging. Invalid explicitly
reviewed input still fails validation. Empty notes preserve any existing bundled
history and published Hub notes; they never become a links list or a fabricated
summary. The missing content can be backfilled after editorial review.

Every native build downloads the same immutable artifact ID, embeds the localized
content, and records its digest in its acceptance receipt. Candidate verification
requires matching digests and includes `release-notes.json` in the hashed release
inventory. The draft body uses its English prose. Job retries reuse the original
artifact, including an empty one; changing content requires a new candidate run
or a separate presentation-only backfill. Publishing never regenerates notes.

When deploying accepted installers to a Hub, consume `release-notes.json`, not
GitHub's entire Release body. With a deployment-side admin token in environment
variable `RELEASE_NOTES_HUB_TOKEN`, publish after enabling a matching installer:

```sh
python tools/github/publish_release_notes.py --file release-notes.json --hub https://hub.example.com
```

This updates only the version's localized presentation metadata with revision
checking, then verifies the signed installer catalog is unchanged. An unavailable
artifact is skipped. Do not copy Candidate markers, download links or checksums
into signed `notes` as a fallback; use empty signed prose when no validated
content exists. Keep Hub credentials outside GitHub build jobs. Existing versions
can be backfilled from their reviewed JSON without rebuilding or resigning assets.
The Hub records the first publication time of the localized metadata.

## Binary publication gates

Review and commit genuine resolution evidence for `third-party/public-release.json`: original licenses, corresponding source archives and actual artifact inventories. Then update the distribution scope in `PUBLIC-SOURCE.json`. Do not simply clear pending items to make CI pass.

Client desktop acceptance requires six entries in `tools/ci/soduwork-acceptance-baselines.json`: `windows-x64-exe`, `linux-x64-deb`, `linux-x64-rpm`, `linux-x64-tar.gz`, `macos-arm64-dmg` and `macos-x64-dmg`. Each entry includes `productName: SoduWork`, a strictly older `version`, `sha256`, and a `url` pointing to the same public GitHub repository, with optional `format`/`size`. Local paths and internal fallback downloads are rejected. For desktop 1.13.15 only, the committed `firstRelease` contract replaces upgrade acceptance with fresh install, restart, reinstall, ciphertext/data persistence and uninstall checks. The older 1.13.13 packages belong to SoduWork Global: the Mac bundle is `SoduWork Global.app`, Windows uses `Uninstall SoduWork Global.exe`, and the Linux DEB package is `soduwork-global`. Global migration is explicitly unsupported. The exception applies only to the six desktop keys listed in the contract and never to subsequent versions. Linux acceptance runs an unlocked synthetic GNOME Keyring inside a D-Bus session and rejects plaintext fallback. Never substitute the candidate as an older version to claim a successful upgrade.

Hub images are delivered as Release assets. After downloading and verifying the manifest, run `docker load --input <image.tar.gz>` and configure your environment using the [self-hosting guide](../ops/self-host/README.md). This workflow does not push to GHCR or migrate company cluster deployment, backup schedules, domains or update services.

## Local validation

```sh
python -m unittest discover -s tools/github -p 'test_*.py'
python -m unittest tools.dev.test_source_export tools.dev.test_deploy tools.security.test_scan_secrets
python tools/github/check_public_ci.py
node --test tools/check-public-source.test.cjs tools/source-manifest.test.cjs tools/check-docs.test.cjs
node tools/check-public-source.cjs
node tools/check-docs.cjs
actionlint .github/workflows/*.yml
```

Application source changes still require full regression checks for affected modules. Review and commit new files before exporting. Do not generate or commit a source manifest in a checkout. In an extracted exporter-produced ZIP, run `node tools/check-source-manifest.cjs` to verify the generated inventory. Public-source, secret and third-party checks remain independent of archive integrity.

Release procedures, workflow documentation and contribution templates are maintained in English.

References: [GitLab migration](https://docs.github.com/en/actions/tutorials/migrate-to-github-actions/manual-migrations/migrate-from-gitlab-cicd), [deployment environments](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments), [Actions limits](https://docs.github.com/en/actions/reference/limits).
