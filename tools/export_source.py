"""Export the committed first-release tree without Git history or local private files."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def canonical(data: bytes) -> bytes:
    if b'\0' in data:
        return data
    try:
        return data.decode('utf-8').replace('\r\n', '\n').encode('utf-8')
    except UnicodeDecodeError:
        return data


def verify(archive: Path) -> int:
    with zipfile.ZipFile(archive) as bundle:
        entries = [entry for entry in bundle.infolist() if not entry.is_dir()]
        names = {entry.filename for entry in entries}
        if len(names) != len(entries):
            raise ValueError('Duplicate archive entries')
        for entry in entries:
            name = entry.filename
            if (name.startswith('/') or '\\' in name or ':' in name
                    or any(part in {'..', '.', '.git'} for part in name.split('/'))
                    or (entry.external_attr >> 16) & 0o170000 == 0o120000):
                raise ValueError('Unsafe archive entry: ' + name)
        manifest = json.loads(bundle.read('tools/distribution/SOURCE-MANIFEST.json'))
        profile = json.loads(bundle.read('tools/distribution/PUBLIC-SOURCE.json'))
        if (manifest.get('schema') != 1 or manifest.get('ok') is not True
                or manifest.get('distribution') != 'public-source'
                or profile.get('id') != 'opensource-v1' or profile.get('sourceOnly') is not True):
            raise ValueError('Missing reviewed source profile or inventory')
        expected = {entry['path']: entry for entry in manifest['files']}
        if len(expected) != len(manifest['files']) or set(expected) | {'tools/distribution/SOURCE-MANIFEST.json'} != names:
            raise ValueError('Archive inventory does not match the committed manifest')
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
            if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
                raise ValueError('Source integrity mismatch: ' + name)
        return len(entries)


def export(output: Path) -> int:
    output = output.expanduser().resolve()
    if output.is_relative_to(ROOT):
        raise ValueError('Write the source archive outside the checkout')
    tree = subprocess.check_output(['git', 'rev-parse', '--verify', 'HEAD^{tree}'], cwd=ROOT, text=True).strip()
    output.parent.mkdir(parents=True, exist_ok=True)
    created = False
    try:
        with output.open('xb') as stream:
            created = True
            subprocess.run(['git', 'archive', '--format=zip', tree], cwd=ROOT, stdout=stream, check=True)
        count = verify(output)
    except BaseException:
        if created:
            output.unlink(missing_ok=True)
        raise
    print(json.dumps({'ok': True, 'files': count, 'archive': str(output), 'gitHistory': False}))
    return count


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='New ZIP path outside the checkout; existing files are never overwritten')
    args = parser.parse_args()
    try:
        export(args.output)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        parser.exit(1, f'Source export failed: {error}\n')
