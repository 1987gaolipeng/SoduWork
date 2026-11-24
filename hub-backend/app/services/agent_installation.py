"""Bounded, read-only installation locations and executable-owned metadata."""
from __future__ import annotations

import json
import hashlib
from functools import lru_cache
import os
from pathlib import Path
import re
import sys
import subprocess


_MACOS_CODEX_CLI = (
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
)


@lru_cache(maxsize=8)
def _signed_codex(path: str, stamp: tuple) -> bool:
    # Cache by file identity so a desktop update is verified on the next lookup.
    requirement = 'anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2" and identifier "codex"'
    result = subprocess.run(["/usr/bin/codesign", "--verify", "--strict", "-R=" + requirement, path],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
    return result.returncode == 0


def macos_codex_cli() -> str:
    """Resolve the signed native CLI installed with the macOS Codex desktop."""
    if sys.platform != "darwin":
        return ""
    for candidate in _MACOS_CODEX_CLI:
        path = Path(candidate)
        try:
            if path.resolve(strict=True) != path or not path.is_file() or not os.access(path, os.X_OK):
                continue
            info = path.stat()
            if _signed_codex(candidate, (info.st_dev, info.st_ino, info.st_ctime_ns, info.st_size)):
                return candidate
        except (OSError, RuntimeError, subprocess.TimeoutExpired):
            continue
    return ""


def path_directories(*, windows: bool = False) -> list[str]:
    """Normalize Windows PATH quoting without changing literal POSIX names."""
    directories = os.environ.get('PATH', '').split(os.pathsep)
    if windows:
        directories = [value.strip('"') for value in directories]
    return [value for value in directories if value]


def prepend_node_path(env: dict, node: str) -> None:
    """Keep spawned Node tools on the selected runtime; never mutate process PATH."""
    directory = os.path.dirname(node)
    if directory:
        env['PATH'] = os.pathsep.join(dict.fromkeys(
            [directory, *(value for value in env.get('PATH', '').split(os.pathsep) if value)]))


def known_bin_dirs() -> list[str]:
    if sys.platform == 'win32':
        return []
    home = Path(os.path.expanduser('~'))
    directories = [Path('/opt/homebrew/bin'), Path('/usr/local/bin'), Path('/usr/bin'),
                   home / '.npm-global/bin', home / '.local/bin']
    nvm = Path(os.environ.get('NVM_DIR') or home / '.nvm') / 'versions/node'
    try:
        versions = sorted((p for p in nvm.iterdir() if p.name.startswith('v') and p.is_dir()),
                          key=lambda p: tuple(int(x) for x in p.name[1:].split('.') if x.isdigit()),
                          reverse=True)[:32]
        directories.extend(p / 'bin' for p in versions)
    except OSError:
        pass
    return [str(p) for p in directories]


def selected_manifest(package: str, executable: str) -> str:
    """Identify a package by its entry or adjacent npm shim, never another prefix."""
    if not package or not executable:
        return ''
    raw = Path(os.path.abspath(executable))
    real = Path(os.path.realpath(raw))
    candidates = [parent / 'package.json' for parent in list(real.parents)[:8]]
    for root in (raw.parent / 'node_modules', raw.parent.parent / 'lib/node_modules'):
        candidates.append(root.joinpath(*package.split('/'), 'package.json'))
    for candidate in dict.fromkeys(candidates):
        try:
            info = json.loads(candidate.read_text(encoding='utf8'))
            if not isinstance(info, dict) or info.get('name') != package:
                continue
            directory = candidate.parent.resolve()
            # Native dependencies inside the selected package retain its identity.
            if real.is_relative_to(directory):
                return str(candidate)
            bins = info.get('bin') or {}
            if isinstance(bins, str):
                bins = {package.rsplit('/', 1)[-1]: bins}
            command = raw.name.removesuffix('.cmd').removesuffix('.exe').removesuffix('.ps1')
            target = (directory / str(bins.get(command) or '')).resolve()
            if (bins.get(command) and target.is_relative_to(directory) and target.is_file()
                    and _shim_references(raw, target)):
                return str(candidate)
        except (OSError, ValueError, TypeError, AttributeError):
            continue
    return ''


def _shim_references(shim: Path, target: Path) -> bool:
    """An adjacent manifest is evidence only when the npm shim names its entry."""
    try:
        with shim.open('rb') as stream:
            content = stream.read(65537)
        if len(content) > 65536:
            return False
        if shim.suffix.lower() not in {'.cmd', '.ps1'} and not content.startswith(b'#!'):
            return False
        text = content.decode('utf8').replace('\\', '/')
        relative = os.path.relpath(target, shim.parent.resolve()).replace('\\', '/')
        return any('"' + prefix + relative + '"' in text
                   for prefix in ('%dp0%/', '$basedir/', '${basedir}/'))
    except (OSError, UnicodeError, ValueError):
        return False


def _standard_npm_shim(shim: Path, target: Path) -> bool:
    """Rewrite only reviewed cmd-shim templates for a plain Node shebang.

    Matching the entry alone does not establish that a wrapper has no bootstrap
    environment, Node flags or hooks. These fingerprints cover cmd-shim 7's
    generated cmd, sh and PowerShell launchers (also unchanged in 6.0.3), with only the entry substituted.
    Unknown templates retain their original command rather than losing behavior.
    """
    try:
        with shim.open('rb') as stream:
            content = stream.read(65537)
        if len(content) > 65536:
            return False
        text = content.decode('utf8').replace('\r\n', '\n')
        relative = os.path.relpath(target, shim.parent.resolve()).replace('\\', '/')
        tokens = ('"%dp0%\\' + relative.replace('/', '\\') + '"',
                  '"$basedir/' + relative + '"')
        for token in tokens:
            text = text.replace(token, '"<npm-entry>"')
        fingerprint = hashlib.sha256(text.strip('\n').encode('utf8')).hexdigest()
        return fingerprint in _PLAIN_NPM_SHIMS
    except (OSError, UnicodeError, ValueError):
        return False


# Generated samples are preserved in tests/fixtures/npm-node-shims.json.
_PLAIN_NPM_SHIMS = {
    '15c9f4e2c862f016f2cae2c4bc358e3b141ebb1dae996f457e3c8bbb0b04dec6',
    'bb5a6be05861e56ec50ad31e02ce9695df4867f7fef6d7c106e32949791f776f',
    'adcff733ed15f076100ce0c0444570edd079cbd2e8e4c6ec2c68571e24aa6c61',
}


def _plain_node_entry(target: Path) -> bool:
    """A direct entry may carry bootstrap flags that explicit Node would drop."""
    try:
        with target.open('rb') as stream:
            raw_first = stream.readline(4097)
        first = raw_first.removeprefix(b'\xef\xbb\xbf')
        if not first.startswith(b'#!'):
            return True
        return len(raw_first) <= 4096 and re.fullmatch(
            rb'#![ \t]*(?:/usr/bin/env[ \t]+node|(?:/[^\s]+/)?node(?:\.exe)?)[ \t]*(?:\r?\n)?',
            first) is not None
    except OSError:
        return False


def selected_node_entry(package: str, executable: str) -> tuple[str, str]:
    """Return the identified JS entry and its engine, preserving native overrides."""
    manifest = selected_manifest(package, executable)
    if not manifest:
        return '', ''
    try:
        info = json.loads(Path(manifest).read_text(encoding='utf8'))
        bins = info.get('bin') or {}
        entries = bins.values() if isinstance(bins, dict) else [bins]
        directory = Path(manifest).parent.resolve()
        raw = Path(executable).absolute()
        for entry in entries:
            target = (directory / str(entry)).resolve()
            if (target.suffix in {'.js', '.mjs', '.cjs'} and target.is_relative_to(directory)
                    and target.is_file() and
                    (_plain_node_entry(target) if raw.resolve() == target else _standard_npm_shim(raw, target))):
                return str(target), str((info.get('engines') or {}).get('node') or '')
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return '', ''
