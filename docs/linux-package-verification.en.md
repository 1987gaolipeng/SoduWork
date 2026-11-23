# Verify Linux downloads

[中文](linux-package-verification.md) · [Documentation](README.md)

Signed Linux releases contain an embedded OpenPGP signature in the RPM, a detached
`.asc` signature for each DEB, RPM and tar.gz, and `SoduWork-Linux-Signing-Key.asc`.
The release manifest records the primary key fingerprint and the hashes of these
exact files. Older releases without these assets have not retroactively acquired
signatures.

Before trusting a new key, compare its **full fingerprint** with the fingerprint
published by the maintainer through a trusted channel. Downloading the package,
key and fingerprint from the same untrusted source does not establish trust.
Maintainers must publish their fingerprint before distributing signed packages;
this source repository does not ship a private key or invent a release identity.

## Fedora and other RPM distributions

Download the RPM and public key from the same release. Inspect the key, compare
its full fingerprint, then import it into the system RPM keyring:

```sh
gpg --show-keys --with-fingerprint SoduWork-Linux-Signing-Key.asc
# Continue only after independently confirming the displayed fingerprint.
sudo rpm --import SoduWork-Linux-Signing-Key.asc
rpmkeys --checksig --verbose SoduWork-X.Y.Z-linux.rpm
sudo dnf --setopt=localpkg_gpgcheck=True install ./SoduWork-X.Y.Z-linux.rpm
```

Replace `X.Y.Z` with the downloaded version. The verification must report a valid
signature, not only valid digests. `NOKEY` means the signing key is not trusted;
an unsigned package needs a newly signed release. Do not disable signature
checking to resolve either case. A signature does not automatically make a
third-party key trusted, so first-time installation still requires key import.

## Debian, Ubuntu and tar.gz downloads

APT authenticates repository metadata (`InRelease` / `Release.gpg`), rather than
automatically checking a detached signature next to a downloaded DEB. SoduWork's
GitHub Release assets are standalone downloads, not an APT repository. Verify the
download explicitly before installation:

```sh
gpg --show-keys --with-fingerprint SoduWork-Linux-Signing-Key.asc
# Continue only after independently confirming the displayed fingerprint.
gpg --import SoduWork-Linux-Signing-Key.asc
gpg --verify SoduWork-X.Y.Z-linux.deb.asc SoduWork-X.Y.Z-linux.deb
# Install only if verification succeeds with the expected signing fingerprint.
sudo apt install ./SoduWork-X.Y.Z-linux.deb
```

For the archive, run `gpg --verify SoduWork-X.Y.Z-linux.tar.gz.asc
SoduWork-X.Y.Z-linux.tar.gz` before extracting it. A GnuPG owner-trust warning is
distinct from a bad signature; independently compare the signing fingerprint.
If an APT repository is introduced later, it also needs signed repository
metadata and a repository-scoped `Signed-By` key configuration.

## Release maintainer setup

The public release workflow requires repository secrets
`SODUWORK_LINUX_SIGNING_KEY_B64` (base64 of the exported private OpenPGP key) and
`SODUWORK_LINUX_SIGNING_PASSPHRASE`, plus repository variable
`SODUWORK_LINUX_SIGNING_FINGERPRINT` (40 hexadecimal characters). Use a dedicated,
password-protected OpenPGP v4 RSA primary signing key of at least 3072 bits, with
an expiry and a securely retained revocation certificate. Export the same primary
key whose fingerprint is configured. Do not reuse Hub update-manifest keys.
Keep the private key, password and backups outside Git; no commercial code-signing
certificate is required for RPM/OpenPGP signing.

Only the Linux release build receives these secrets. GnuPG uses a temporary home;
the key and agent are removed on normal completion or failure. Build dependencies
do not receive these credentials in their environment. Signing and verification
finish before the installation inventory hashes are generated. Native acceptance
imports the public key in disposable Rocky 9 and Fedora 45 containers and requires
local package signature checking. The public key and detached signatures travel
through the same immutable candidate inventory as the installers. Acceptance
verifies them again before sealing the release receipt.

The committed 1.13.18 RPM upgrade baseline is signed and requires OpenPGP
verification. Testing the older, unsigned 1.13.17 RPM requires an explicit
`legacy-unsigned` baseline. Only that old-package test path can install without
an OpenPGP signature, after rechecking the pinned SHA-256 in the disposable
container. Its exception and hash are recorded in the acceptance receipt. Signed
baselines and new candidates always require signatures.

The separate package-validation workflow stays unsigned and emits checksum
evidence only; its outputs cannot be promoted into a public release. Real signing
regressions use temporary fixture keys in Linux CI. A fixture round trip does not
prove that a production key is configured or that an actual SoduWork desktop
installer has passed the full native acceptance matrix.

To test the configured key on real installers, manually run **Native package
validation** with `signed_linux` enabled. It builds only Linux, runs the native
installation matrix and retains signed packages, the public key, signatures and
a validation-only receipt as Actions artifacts. It does not create a Release or
authorize later publication of those artifacts. The repository must already have
reviewed binary distribution scope and `PACKAGE_VALIDATION_REPOSITORY` configured.
