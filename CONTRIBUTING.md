# Contributing to SoduWork

[简体中文](docs/contributing.zh-CN.md) · **English** · [Documentation](docs/README.md)

Thanks for helping with SoduWork. Bug reports, docs, translations, tests and code are all welcome. By taking part, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Contributors using coding agents can start with the public [AGENTS.md](AGENTS.md).

## Before you start

- **Bugs and feature requests**: use the [issue templates](https://github.com/mdiri-ai/SoduWork/issues/new/choose). Questions and ideas go to [Discussions](https://github.com/mdiri-ai/SoduWork/discussions).
- **Security issues**: don't open a public issue. Report privately as described in the [security policy](SECURITY.md).
- **Larger changes** (new features, data schemas, public protocols): open an issue first to describe the user problem and your approach, and agree on the direction before sending a pull request.
- **Local setup**: follow the [startup guide](docs/getting-started.en.md) to run an isolated local instance. The [developer guide](docs/development.en.md) explains the layout and where each module starts. The public source boundary is defined in [PUBLIC-SOURCE.json](tools/distribution/PUBLIC-SOURCE.json) and the [release scope](docs/release-scope.en.md).

## Making a change

1. Create a short-lived branch from the latest mainline and preserve existing uncommitted changes. Validate with isolated accounts, temporary ports, and synthetic data.
2. In the pull request, explain the user problem, reproduction, and expected behavior. Use Alembic migrations for schema changes. Do not directly delete device records, user data, or public protocols.
3. Run the checks relevant to your change:
   - Client: `npm test` in `client/`;
   - Admin console: `npm run build` and `node --test tests/*.test.mjs` in `hub-frontend/`;
   - Launcher: `python -m unittest tools.dev.test_start_local` at the root;
   - Backend: choose checks with `python quality_gate.py --help` in `hub-backend/`.
4. Run `node tools/check-public-source.cjs` and `node tools/check-third-party.cjs` from the root. Review and stage new public files. Git tracks the source inventory; do not generate or commit `SOURCE-MANIFEST.json`. The source exporter generates it inside each archive from the committed files.
5. Exclude logs, screenshots, databases, accounts, tokens, private addresses, installers, and dependency caches.
6. In the pull request, state the platforms you actually verified and any remaining gaps. Passing fixtures do not prove real-model or production behavior. Build release resources from current source rather than reusing old Runner binaries or an installed application's resources.

Also run `node tools/check-docs.cjs` and `python tools/security/scan_secrets.py --download` before submitting. The scanner pins its version and download checksums, includes tests, and approves reviewed false positives only by exact source-line hashes. Download or verification failure fails the check. See [secret scanning](tools/security/README.md).

## Docs and translations

For documentation changes, keep paired Chinese and English pages in sync according to the [translation conventions](docs/development.en.md#documentation-and-translations), and keep the language links at the top of each page.

## Sign your commits (DCO)

This project uses the [Developer Certificate of Origin 1.1](DCO.txt) (DCO). By signing off a commit, you certify that you have the right to submit the change under the project's license.

```bash
git commit -s -m "Fix upload retry after a timeout"
```

This adds a `Signed-off-by: Your Name <you@example.com>` line to the commit message. Use your real name and an email address where you can be reached. Every pull request checks for sign-offs. To add a missing one:

```bash
git commit --amend -s          # last commit
git rebase --signoff main      # all commits on your branch
```

The contribution policy may change; any change applies only to contributions made after it is announced.

## License

MDiRi project source uses the [MIT License](LICENSE), and your contributions are released under the same license. Retained third-party code, dependencies and assets keep their own licenses and original notices; see [third-party notices](NOTICE.md). Verify provenance and distribution rights before adding a skill, model, document, or asset; the project license does not override third-party terms.
