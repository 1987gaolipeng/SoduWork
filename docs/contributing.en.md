# Contributing to SoduWork

[简体中文](../CONTRIBUTING.md) · **English** · [Documentation](index.en.md)

Start with the [startup guide](getting-started.en.md) and [developer guide](development.en.md). The public source boundary is defined in [PUBLIC-SOURCE.json](../tools/distribution/PUBLIC-SOURCE.json) and [release scope](release-scope.en.md).

1. Work on a development branch and preserve existing uncommitted changes. Validate with isolated accounts, temporary ports, and synthetic data.
2. Explain the user problem, reproduction, and expected behavior. Use Alembic migrations for schema changes. Do not directly delete device records, user data, or compatible protocols.
3. Run relevant checks: `npm test` in `client/`; `npm run build` and `node --test tests/*.test.mjs` in `hub-frontend/`; `python -m unittest tools.dev.test_start_local` at the root for startup changes. Choose backend checks with `python quality_gate.py --help` in `hub-backend/`.
4. Run `node tools/check-public-source.cjs` and `node tools/check-third-party.cjs` from the root. Stage new files, refresh the manifest with `node tools/check-source-manifest.cjs --write-manifest`, then verify with `node tools/check-source-manifest.cjs`.
5. Exclude logs, screenshots, databases, accounts, tokens, private addresses, installers, and dependency caches. Do not commit internal product discussions, customer material, or release credentials.
6. State the platforms actually verified and any remaining gaps. Fixtures do not prove real-model or production delivery. Build release resources from current source rather than reusing old Runner binaries or an installed application's resources.

Also run `node tools/check-docs.cjs` and `python tools/security/scan_secrets.py --download` before submitting. The scanner pins its version and download checksums, includes tests, and approves reviewed false positives only by exact source-line hashes. Download or verification failure fails the check. See [secret scanning](../tools/security/README.md).

For documentation changes, keep paired translations synchronized according to the [translation conventions](development.en.md#documentation-and-translations).

MDiRi project source uses [MIT](../LICENSE). Third-party runtimes, fonts, and assets retain their own licenses and notices. Verify provenance and distribution rights before adding a skill, model, document, or asset; the project license does not override third-party terms.

Follow the [security reporting policy](security.en.md). Do not paste real credentials or live exploit targets into public issues.
