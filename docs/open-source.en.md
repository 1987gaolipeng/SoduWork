# Using and distributing source

[简体中文](open-source.md) · **English** · [Documentation](index.en.md)

For local use, see [startup](getting-started.en.md); for changes, see [development](development.en.md); for a team deployment, see [self-hosting](../ops/self-host/README.en.md).

## Configure your services

The desktop defaults to `http://127.0.0.1:18989`. Source and packaged clients allow selecting and saving a Hub URL on the login screen. Accounts and device credentials remain separate for each service.

Templates contain no usable passwords or tokens. Generate and protect credentials at deployment time. Exclude environment files, databases, uploads, device credentials, and dependency caches from source archives.

Before distributing installers, set your own `homepage` and Linux `maintainer` in `client/package.json`. The website entry is unavailable without a homepage, and the example maintainer email must be replaced.

## Plugins and updates

Plugins use `.soduwork-plugin`. Clients and the management UI accept the current branded package and draft identifiers; retired brand formats have no alias entry points.

Automatic updates require your own release trust. Neither `client/update-trust.json` nor `hub-backend/client-update-trust.json` trusts any signing public key by default. Before distributing installers, configure matching Ed25519 public keys in both files and explicitly set `SODUWORK_CLIENT_SIGNING_KEY_ID`. Keep signing private keys outside source and installers. Without configured trust, the client refuses automatic update downloads and installation.

Use `SODUWORK_ACCEPT_BASELINES_FILE` to supply previous installers for upgrade acceptance. Each record contains product name, version, format, SHA-256, and a download URL or local path. Checks use fixed versions rather than automatically choosing the latest package.

Self-hosted packages use the `stable` update channel by default. Set `soduworkUpdateChannel` in `client/package.json` to `beta` before packaging a beta build and publish to the matching channel. Only `stable` and `beta` are supported; the packaged channel does not change with the login server or runtime environment.

## Export public source

Run scope and license checks from the root:

```sh
node tools/check-public-source.cjs
node tools/check-third-party.cjs
```

Review and commit the source before exporting. Git tracks development changes; there is no source manifest to refresh or commit for ordinary PRs or dependency updates. The output must be outside the source directory and must not already exist:

```sh
python tools/export_source.py --output ../soduwork-source-v1.zip
```

The exporter generates `tools/distribution/SOURCE-MANIFEST.json` from the archived files, records the source commit, and verifies the resulting ZIP. It rejects excluded material, symbolic links and escaping paths. It exports the current commit without Git history, untracked files or caches. Uncommitted changes are not included; choose a new filename to preserve existing archives.

The generated manifest records hashes and sizes. UTF-8 text uses canonical LF newlines, supporting Windows CRLF; binary files use exact bytes. In an extracted exporter-produced ZIP, run `node tools/check-source-manifest.cjs` to detect changed, missing or extra files. In a Git checkout, that command uses Git's inventory and does not require a manifest. The manifest verifies archive consistency, not publisher identity, and does not replace secret scanning, third-party authorization or Git history review.

## Prepare a GitHub repository

Extract the verified ZIP into a new empty directory, initialize a new Git repository there, review the files, and connect your own GitHub remote. The generated source manifest is ignored by Git and must not be added to the new repository. Do not make the original development repository public or import private branches, old tags, or development history.

Root `README.md` is the English entry point, with a top link to the Chinese `README.zh-CN.md`. Relative navigation works across forks and repository renames. Follow the [translation conventions](development.en.md#documentation-and-translations) to add another language.

See [LICENSE](../LICENSE), [NOTICE.md](../NOTICE.md), and `third-party/` for project and dependency terms. Installers, container images, and other binary dependencies need separate licensing and runtime verification.
