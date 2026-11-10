# MIT source preparation and review boundaries

[简体中文](mit-review.md) · **English** · [Third-party materials](README.en.md)

The root MIT license and MDiRi attribution cover project-owned material the project has the right to license. This document records review boundaries; it does not certify zero risk or provide legal clearance.

## Project and third-party material

- Preserve original third-party copyright and license notices. Do not replace them with MDiRi or MIT declarations.
- Retained MIT, BSD-3-Clause, Apache-2.0 and CC0 material remains subject to its original terms. DOMPurify retains its dual-license header and original Apache-2.0 text; the inventory records that licensing option.
- Copyright permission for an icon collection does not grant trademark rights. API compatibility names, model names and service names do not imply affiliation or endorsement.
- Bundled skill scope is documented in `skills/THIRD-PARTY.md`. Do not copy commercial skills, account configuration or model weights from a developer machine.

## Reproducible checks

`source-files.json` records 95 existing vendored source, artwork, provenance and license files. Checks cover original notices, exact file hashes, new files in protected directories and symbolic links. CRLF/LF conversion alone does not change text hashes.

```sh
node tools/check-third-party.cjs
node --test tools/check-source-provenance.test.cjs client/tests/third-party-notices.test.cjs
```

Review origin, original terms, local changes and applicable obligations before changing hashes. A matching hash proves consistency with the record; it cannot establish ownership, supply missing permission or license unknown material under MIT. Package-manager dependencies, project-owned images and final installers need separate review. This inventory is not a complete SBOM.

Both npm lockfiles use only HTTPS downloads from the official `registry.npmjs.org` with integrity hashes; dependency versions remain unchanged. Private registries, credential-bearing URLs, local links and missing integrity records are rejected. Declared license identifiers do not substitute for original permission.

The Windows validation wheel for `dnspython 2.9.0` omits the original license file. Its complete ISC notice was obtained from the matching official pinned commit and recorded with a hash. Runner builds include that text and verify the installed version and notice hash. Future versions require review rather than inheriting an old record. Other platforms and final runtime dependencies still require artifact-level checks.

## Source launches and local validation builds

Ordinary source launches remain available. Reading or switching model configuration does not automatically submit inference requests. Model calls start when a user sends a message or runs a task.

`public-release.json` retains unresolved binary-distribution items: original dependency permission, Windows shell corresponding-source archives and final platform artifact inventories. While `tools/distribution/PUBLIC-SOURCE.json` sets `sourceOnly: true` or any item is unresolved, an ordinary installer build stops.

To validate an installer locally before those items are resolved, build explicitly as follows. This does not grant public distribution rights:

```powershell
$env:SODUWORK_INTERNAL_BUILD = '1'
cd client
npm run build
```

```sh
cd client
SODUWORK_INTERNAL_BUILD=1 npm run build:linux
```

Validation builds retain every blocker and write `internalOnly: true` and `publicDistributionAllowed: false` to `third-party/inventory/distribution-review.json`. No pending item becomes resolved as a result.
