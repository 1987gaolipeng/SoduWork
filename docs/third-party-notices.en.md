# Third-party notices

[简体中文](../NOTICE.md) · **English** · [Documentation](index.en.md)

Project-owned source uses the root MIT license. Third-party code, fonts, assets, and any separately imported skills retain their original terms. See `third-party/manifest.json`, `client/THIRD_PARTY_NOTICES.md`, and any component-specific LICENSE, UPSTREAM.md, or ADAPTATIONS.md.

Connector icon provenance is recorded in `client/assets/connector-brands/sources.json`. An asset license does not grant a third-party trademark endorsement.

Binary releases need the notices and applicable corresponding source for the actual bundled components. Outstanding materials are tracked in `third-party/public-release.json`; a passing source check does not certify binary distribution.

From the root:

```sh
node tools/check-third-party.cjs
```

Or run `npm run check:licenses` from `client/`. Checks verify fixed-version evidence, hashes, and build integration. Packaging collects original licenses for copied runtime dependencies. Runner retains installed Python metadata and licenses; Hub includes project and third-party materials.

See [distribution materials](../third-party/README.en.md) for coverage and remaining work.
