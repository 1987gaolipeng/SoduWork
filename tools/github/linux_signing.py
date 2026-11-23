"""OpenPGP signing for public Linux packages, with isolated keyrings and RPM DBs."""
from __future__ import annotations

import base64
from contextlib import contextmanager
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile

PUBLIC_KEY = "SoduWork-Linux-Signing-Key.asc"
PREFIX = "SODUWORK_LINUX_SIGNING_"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def package_names(version):
    require(re.fullmatch(r"\d+\.\d+\.\d+", version), "Invalid Linux package version")
    return [f"SoduWork-{version}-linux.{ext}" for ext in ("deb", "rpm", "tar.gz")]


def asset_names(version):
    names = package_names(version)
    return names + [name + ".asc" for name in names] + [PUBLIC_KEY]


def settings(env):
    fingerprint = env.get(PREFIX + "FINGERPRINT", "").strip().upper()
    require(re.fullmatch(r"[A-F0-9]{40}", fingerprint),
            "Set SODUWORK_LINUX_SIGNING_FINGERPRINT to the full OpenPGP v4 primary fingerprint")
    require(env.get(PREFIX + "KEY_B64"), "Public Linux releases require SODUWORK_LINUX_SIGNING_KEY_B64")
    password = env.get(PREFIX + "PASSPHRASE", "")
    require(password and not any(c in password for c in "\r\n\0"),
            "Set a nonempty, single-line SODUWORK_LINUX_SIGNING_PASSPHRASE")
    try:
        key = base64.b64decode(env[PREFIX + "KEY_B64"], validate=True)
    except (ValueError, TypeError):
        raise ValueError("Invalid base64 Linux signing key") from None
    require(key, "Empty Linux signing key")
    return fingerprint, key, password


def command(*args, env, data=None):
    # Never echo GnuPG diagnostics, imported key material or passphrases into CI.
    result = subprocess.run([str(a) for a in args], input=data, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    if result.returncode:
        raise ValueError(f"Linux signing: {Path(args[0]).name} failed (exit {result.returncode})")
    return result.stdout


@contextmanager
def keyring():
    with tempfile.TemporaryDirectory(prefix="soduwork-linux-signing-") as directory:
        home = Path(directory)
        home.chmod(0o700)
        env = {k: v for k, v in os.environ.items() if not k.startswith(PREFIX)}
        env.update(GNUPGHOME=str(home), LC_ALL="C")
        try:
            yield home, env
        finally:
            # Stop only the agent for this ephemeral home, including on failure.
            subprocess.run(["gpgconf", "--homedir", str(home), "--kill", "gpg-agent"],
                           env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=10, check=False)


def gpg(home, env, *args, data=None):
    return command("gpg", "--no-options", "--homedir", home, "--batch", *args, env=env, data=data)


def check_key(home, env, fingerprint, *, secret=False):
    listing = gpg(home, env, "--with-colons", "--fingerprint",
                  "--list-secret-keys" if secret else "--list-keys").decode()
    primary = []
    key = None
    for line in listing.splitlines():
        fields = line.split(":")
        if fields[0] in ("sec", "pub"):
            key = fields
        elif fields[0] in ("ssb", "sub"):
            key = None
        elif fields[0] == "fpr" and key is not None:
            primary.append(fields[9])
            require(key[3] == "1" and int(key[2]) >= 3072 and "s" in key[11],
                    "Linux signing requires an RSA 3072+ primary signing key")
            require(key[1] not in ("r", "e", "d"), "Linux signing key is revoked, expired or disabled")
            key = None
    require(primary == [fingerprint], "Linux signing primary fingerprint differs from configured trust")


def verify_rpm(package, public_key, home, env):
    database = home / "rpmdb"
    database.mkdir()
    command("rpm", "--dbpath", database, "--initdb", env=env)
    command("rpmkeys", "--dbpath", database, "--import", public_key, env=env)
    output = command("rpmkeys", "--dbpath", database, "--checksig", "--verbose", package, env=env).decode()
    # RPM 4 can exit zero for an unsigned package with valid checksums.
    require(re.search(r"signature.*: OK\s*$", output, re.MULTILINE | re.IGNORECASE), "RPM has no verified OpenPGP signature")
    require(not re.search(r"NOKEY|NOT OK|BAD|UNTRUSTED", output), "RPM signature is not trusted")


def verify_packages(folder, version, fingerprint):
    folder = Path(folder).resolve()
    require(re.fullmatch(r"[A-F0-9]{40}", fingerprint), "Invalid Linux signing fingerprint")
    for name in asset_names(version):
        file = folder / name
        require(file.is_file() and not file.is_symlink() and file.stat().st_size > 0,
                "Missing or unsafe signed Linux artifact: " + name)
    with keyring() as (home, env):
        gpg(home, env, "--import", folder / PUBLIC_KEY)
        check_key(home, env, fingerprint)
        for name in package_names(version):
            status = gpg(home, env, "--status-fd", "1", "--verify", folder / (name + ".asc"),
                         folder / name).decode()
            require(any(line.startswith("[GNUPG:] VALIDSIG " + fingerprint + " ")
                        for line in status.splitlines()), "Linux detached signature uses another signing key")
        verify_rpm(folder / f"SoduWork-{version}-linux.rpm", folder / PUBLIC_KEY, home, env)
    return {"schema": 1, "primaryFingerprint": fingerprint, "rpmEmbedded": True,
            "detached": package_names(version), "publicKey": PUBLIC_KEY}


def sign_packages(folder, version, signing_env):
    fingerprint, key, password = settings(signing_env)
    folder = Path(folder).resolve()
    for tool in ("gpg", "gpgconf", "rpmsign", "rpm", "rpmkeys"):
        require(shutil.which(tool), "Linux signing requires " + tool)
    for name in package_names(version):
        require((folder / name).is_file() and not (folder / name).is_symlink(), "Missing Linux package: " + name)
    # Do not touch the installers until all signatures have passed verification.
    with keyring() as (home, env):
        output = home / "signed"
        output.mkdir()
        for name in package_names(version):
            shutil.copyfile(folder / name, output / name)
        gpg(home, env, "--import", data=key)
        check_key(home, env, fingerprint, secret=True)
        (output / PUBLIC_KEY).write_bytes(gpg(home, env, "--armor", "--export", fingerprint))
        passfile = home / "passphrase"
        passfile.write_text(password, encoding="utf-8")
        passfile.chmod(0o600)
        # RPM 4.17 on Ubuntu 22.04 uses a command macro; quote its arguments,
        # reject macro expansion in paths, and keep the password out of argv.
        require("%" not in str(home), "RPM signing path contains a macro escape")
        signer = " ".join(shlex.quote(str(arg)) for arg in (
            shutil.which("gpg"), "--no-options", "--homedir", home, "--batch", "--no-armor",
            "--pinentry-mode", "loopback", "--passphrase-file", passfile,
            "--digest-algo", "SHA256", "--local-user", fingerprint + "!"))
        # RPM 6 passes input/output as macro arguments instead of defining the
        # legacy filename macros used by RPM 4.17.
        positional = command("rpm", "--eval", "%{?__openpgp_sign_cmd:1}", env=env).strip() == b"1"
        signer += (' --detach-sign --output %{shescape:%{2}} -- %{shescape:%{1}}' if positional else
                   ' --detach-sign --output "%{__signature_filename}" "%{__plaintext_filename}"')
        command("rpmsign", "--define", "_gpg_name " + fingerprint,
                "--define", ("__gpg_sign_cmd() " if positional else "__gpg_sign_cmd ") + signer, "--addsign",
                output / f"SoduWork-{version}-linux.rpm", env=env)
        for name in package_names(version):
            gpg(home, env, "--pinentry-mode", "loopback", "--passphrase-fd", "0",
                "--local-user", fingerprint + "!", "--digest-algo", "SHA256", "--armor",
                "--detach-sign", "--output", output / (name + ".asc"), output / name,
                data=password.encode())
        receipt = verify_packages(output, version, fingerprint)
        for name in asset_names(version):
            shutil.copyfile(output / name, folder / name)
    return receipt
