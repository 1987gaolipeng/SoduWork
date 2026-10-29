"""Prepare the pinned official DWS binary without running its Agent-skill installer."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import sys
import tarfile
import tempfile
import zipfile

MAX_BYTES = 128 * 1024 * 1024


def prepare(prefix: Path, lock: dict, system: str | None = None,
            machine: str | None = None) -> dict:
    if not prefix.is_absolute():
        raise ValueError('CLI prefix must be an absolute directory')
    prefix = prefix.resolve(strict=True)
    package = prefix / 'node_modules' / 'dingtalk-workspace-cli'
    if not package.resolve(strict=True).is_relative_to(prefix):
        raise ValueError('Package cannot escape the CLI directory')
    metadata = json.loads((package / 'package.json').read_text(encoding='utf8'))
    if metadata.get('name') != lock['package'] or metadata.get('version') != lock['version']:
        raise ValueError('Install the exact pinned official npm package with --ignore-scripts first')
    system = system or sys.platform
    machine = (machine or platform.machine()).lower()
    os_name = {'win32': 'windows', 'darwin': 'darwin', 'linux': 'linux'}.get(system)
    arch = {'amd64': 'amd64', 'x86_64': 'amd64', 'x64': 'amd64',
            'arm64': 'arm64', 'aarch64': 'arm64'}.get(machine)
    if not os_name or not arch:
        raise ValueError('Unsupported DWS platform or architecture')
    binary = 'dws.exe' if os_name == 'windows' else 'dws'
    suffix = '.zip' if os_name == 'windows' else '.tar.gz'
    name = f'dws-{os_name}-{arch}' + suffix
    asset = package / 'assets' / name
    if not asset.resolve(strict=True).is_relative_to(package.resolve()):
        raise ValueError('Archive cannot escape the official package')
    if asset.stat().st_size > MAX_BYTES:
        raise ValueError('Official archive is too large')
    checksums = {}
    for line in (package / 'assets/checksums.txt').read_text(encoding='utf8').splitlines():
        fields = line.split()
        if len(fields) == 2 and re.fullmatch('[0-9a-f]{64}', fields[0]):
            checksums[fields[1].lstrip('*')] = fields[0]
    data = asset.read_bytes()
    if checksums.get(name) != hashlib.sha256(data).hexdigest():
        raise ValueError('Official archive checksum mismatch')
    if suffix == '.zip':
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = [item for item in archive.infolist() if item.filename == binary]
            if len(entries) != 1 or entries[0].is_dir() or entries[0].file_size > MAX_BYTES:
                raise ValueError('Official ZIP must contain one bounded root executable')
            payload = archive.read(entries[0])
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            entries = [item for item in archive.getmembers() if item.name in (binary, './' + binary)]
            if len(entries) != 1 or not entries[0].isfile() or entries[0].size > MAX_BYTES:
                raise ValueError('Official TAR must contain one bounded root executable')
            stream = archive.extractfile(entries[0])
            if stream is None:
                raise ValueError('Official executable is missing')
            payload = stream.read(MAX_BYTES + 1)
    if not payload or len(payload) > MAX_BYTES:
        raise ValueError('Official executable has invalid size')
    vendor = package / 'vendor'
    vendor.mkdir(exist_ok=True)
    if vendor.is_symlink() or not vendor.resolve().is_relative_to(package.resolve()):
        raise ValueError('Vendor directory cannot escape the official package')
    target = vendor / binary
    digest = hashlib.sha256(payload).hexdigest()
    if target.is_symlink():
        raise ValueError('Executable cannot be a symbolic link')
    if target.exists():
        if target.read_bytes() != payload:
            raise ValueError('Existing executable differs; use a fresh CLI directory')
    else:
        fd, pending = tempfile.mkstemp(prefix='.dws-', suffix='.tmp', dir=vendor)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(pending, 0o755)
            try:
                os.link(pending, target)
            except FileExistsError:
                if target.read_bytes() != payload:
                    raise ValueError('Concurrent executable content conflict')
        finally:
            os.unlink(pending)
    return {'status': 'prepared', 'version': lock['version'], 'path': str(target),
            'sha256': digest, 'authentication': 'not-checked'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prefix', required=True, type=Path)
    args = parser.parse_args()
    lock = json.loads((Path(__file__).resolve().parents[1] / 'upstream-lock.json').read_text(encoding='utf8'))
    try:
        print(json.dumps(prepare(args.prefix, lock), ensure_ascii=False))
    except (OSError, ValueError, tarfile.TarError, zipfile.BadZipFile) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
