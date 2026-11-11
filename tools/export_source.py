"""Export the committed first-release tree without Git history or local private files."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = 'tools/distribution/SOURCE-MANIFEST.json'
SCOPE = 'Current source snapshot only; not Git history, complete secret detection or legal clearance.'


def canonical(data: bytes) -> bytes:
    if b'\0' in data:
        return data
    try:
        return data.decode('utf-8').replace('\r\n', '\n').encode('utf-8')
    except UnicodeDecodeError:
        return data


def archive_entries(bundle: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    entries = bundle.infolist()
    if len({entry.filename for entry in entries}) != len(entries):
        raise ValueError('Duplicate archive entries')
    for entry in entries:
        name = entry.filename.rstrip('/') if entry.is_dir() else entry.filename
        if (name.startswith('/') or '\\' in name or ':' in name
                or any(part in {'', '..', '.', '.git'} for part in name.split('/'))
                or (entry.external_attr >> 16) & 0o170000 == 0o120000):
            raise ValueError('Unsafe archive entry: ' + name)
    return [entry for entry in entries if not entry.is_dir()]


def add_manifest(archive: Path, commit: str, expected: set[str]) -> None:
    """Hash archived bytes, never the working tree or a developer-maintained inventory."""
    with zipfile.ZipFile(archive, 'a') as bundle:
        entries = archive_entries(bundle)
        if not entries or any(entry.filename == MANIFEST for entry in entries):
            raise ValueError('Export requires source without a committed source manifest')
        if {entry.filename for entry in entries} != expected:
            raise ValueError('Archive files do not match the committed tree')
        files = []
        for entry in sorted(entries, key=lambda item: item.filename):
            data = canonical(bundle.read(entry))
            files.append({'path': entry.filename, 'bytes': len(data),
                          'sha256': hashlib.sha256(data).hexdigest()})
        manifest = {'schema': 1, 'ok': True, 'distribution': 'public-source',
                    'scope': SCOPE, 'commit': commit, 'files': files}
        info = zipfile.ZipInfo(MANIFEST, date_time=entries[0].date_time)
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        bundle.writestr(info, json.dumps(manifest, indent=2) + '\n')


def verify(archive: Path) -> int:
    with zipfile.ZipFile(archive) as bundle:
        entries = archive_entries(bundle)
        names = {entry.filename for entry in entries}
        manifest = json.loads(bundle.read(MANIFEST))
        profile = json.loads(bundle.read('tools/distribution/PUBLIC-SOURCE.json'))
        if (manifest.get('schema') != 1 or manifest.get('ok') is not True
                or manifest.get('distribution') != 'public-source'
                or profile.get('id') != 'opensource-v1' or type(profile.get('sourceOnly')) is not bool):
            raise ValueError('Missing reviewed source profile or inventory')
        expected = {entry['path']: entry for entry in manifest['files']}
        identifiers = profile.get('excludedIdentifiers', [])
        if not isinstance(identifiers, list) or any(not isinstance(value, str) or not value.strip() for value in identifiers):
            raise ValueError('Invalid excluded identifiers')
        if len(expected) != len(manifest['files']) or set(expected) | {MANIFEST} != names:
            raise ValueError('Archive inventory does not match the generated manifest')
        for name, entry in expected.items():
            if (any(name.startswith(prefix) for prefix in profile['excludedPrefixes'])
                    or name in profile['excludedFiles']
                    or name.startswith('ops/') and not name.startswith('ops/self-host/')
                    or name.startswith('skills/') and len(name.split('/')) > 2
                    and name.split('/')[1] not in profile['skills']
                    or name.startswith('tools/ci/') and name[9:] not in profile['buildChecks']
                    or name.endswith('/agents/openai.yaml')):
                raise ValueError('Excluded first-release material: ' + name)
            data = canonical(bundle.read(name))
            content = '' if name == 'tools/distribution/PUBLIC-SOURCE.json' else data.decode('utf-8', errors='replace').lower()
            if any(value.lower() in name.lower() or value.lower() in content for value in identifiers):
                raise ValueError('Excluded business identifier: ' + name)
            if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
                raise ValueError('Source integrity mismatch: ' + name)
        return len(entries)


def export(output: Path) -> int:
    output = output.expanduser().resolve()
    if output.is_relative_to(ROOT):
        raise ValueError('Write the source archive outside the checkout')
    commit = subprocess.check_output(['git', 'rev-parse', '--verify', 'HEAD^{commit}'], cwd=ROOT, text=True).strip()
    expected = set(subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', '-z', commit], cwd=ROOT)
                   .decode('utf-8').rstrip('\0').split('\0'))
    output.parent.mkdir(parents=True, exist_ok=True)
    created = False
    try:
        with output.open('xb') as stream:
            created = True
            subprocess.run(['git', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf',
                            'archive', '--format=zip', commit], cwd=ROOT, stdout=stream, check=True)
        add_manifest(output, commit, expected)
        count = verify(output)
    except BaseException:
        if created:
            output.unlink(missing_ok=True)
        raise
    print(json.dumps({'ok': True, 'files': count, 'archive': str(output), 'commit': commit, 'gitHistory': False}))
    return count


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='New ZIP path outside the checkout; existing files are never overwritten')
    args = parser.parse_args()
    try:
        export(args.output)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        parser.exit(1, f'Source export failed: {error}\n')
