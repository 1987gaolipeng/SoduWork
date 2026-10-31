"""Execute installer bootstrap with isolated OS/package-manager fixtures."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).parent / 'installers' / 'runner-install.sh'

def bash_tools():
    if os.name == 'nt':
        git = shutil.which('git')
        candidates = [Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Git/usr/bin/bash.exe']
        if git:
            candidates.append(Path(git).parent.parent / 'usr/bin/bash.exe')
        found = shutil.which('bash')
        if found:
            candidates.append(Path(found))
        for candidate in candidates:
            cygpath = candidate.with_name('cygpath.exe')
            if candidate.is_file() and cygpath.is_file():
                return str(candidate), str(cygpath)
        raise RuntimeError('Git Bash with cygpath is required for the isolated Linux installer test')
    bash = shutil.which('bash')
    if not bash:
        raise RuntimeError('Bash is required for the isolated Linux installer test')
    return bash, None


# Fake only machine/package boundaries; bash executes the production branches.
TOOL = r'''
import json, os, pathlib, shutil, subprocess, sys
root = pathlib.Path(os.environ['FIXTURE']).resolve()
invocation = sys.argv[1]
name = pathlib.Path(invocation).name
args = sys.argv[2:]
with (root / 'calls').open('a') as f:
    f.write(json.dumps([name, args]) + '\n')
if name in ('apt-get', 'dnf', 'yum'):
    (root / 'installed').touch()
    sys.exit(0)
if name == 'id':
    print(0)
    sys.exit(0)
is_venv = 'venv' in pathlib.Path(invocation).parts
installed = (root / 'installed').exists()
if args[:2] == ['-m', 'venv']:
    if not installed:
        sys.exit(1)
    target_path = args[2]
    if os.name == 'nt':
        target_path = subprocess.check_output([os.environ['FIXTURE_CYGPATH'], '-w', target_path],
                                             text=True, encoding='utf-8').strip()
    target = pathlib.Path(target_path).resolve() / 'bin'
    assert target.is_relative_to(root), 'venv fixture must stay inside its temporary root'
    target.mkdir(parents=True, exist_ok=True)
    py = target / 'python'
    if not py.exists():
        shutil.copyfile(root / 'bin' / 'python3.11', py)
        py.chmod(0o755)
    sys.exit(0)
if args[:2] == ['-m', 'pip']:
    if not is_venv or not installed:
        sys.exit(1)
    if 'install' in args and os.environ.get('FAIL_PIP'):
        sys.exit(1)
    sys.exit(0)
if name in ('curl', 'tar', 'gzip', 'git'):
    raise AssertionError('Bootstrap dependency fixture must not execute ' + name)
if args and args[0] == '-c':
    if 'version_info' in args[1]:
        # EL8 system Python remains 3.6, even after installing Python 3.11.
        sys.exit(0 if is_venv or name == 'python3.11' and (installed or (root / 'supported').exists()) else 1)
    if 'inspect.signature' in args[1]:
        sys.exit(0 if installed and is_venv else 1)
    if 'import websockets' in args[1]:
        # Distro websockets imports successfully but is incompatible (10.4).
        sys.exit(0)
sys.exit(0)
'''


class LinuxInstallerTests(unittest.TestCase):
    def bootstrap(self, distro='ubuntu', version='24.04', *, installed=False,
                  partial_venv=False, fail_pip=False, supported=True):
        bash, cygpath = bash_tools()
        def shell_path(value):
            if cygpath:
                return subprocess.check_output([cygpath, '-u', str(value)],
                                               text=True, encoding='utf-8').strip()
            return str(value)
        with tempfile.TemporaryDirectory(prefix='soduwork linux install-') as temp:
            root = Path(temp)
            binaries = root / 'bin'
            binaries.mkdir()
            tool_source = root / 'tool.py'
            tool_source.write_text(TOOL, encoding='utf-8')
            # A wrapper preserves the invoked alias without requiring symlink
            # privileges or a Windows executable path in a POSIX shebang.
            wrapper = ('#!/bin/sh\nexec ' + shlex.quote(shell_path(sys.executable)) + ' '
                       + shlex.quote(str(tool_source)) + ' "$0" "$@"\n')
            for name in ('python3.11', 'python3', 'python3.14', 'python3.13', 'python3.12',
                         'python3.10', 'apt-get', 'dnf', 'yum', 'id', 'curl', 'tar', 'gzip', 'git'):
                tool = binaries / name
                tool.write_text(wrapper, encoding='utf-8', newline='\n')
                tool.chmod(0o755)
            if supported:
                (root / 'supported').touch()
            if installed:
                (root / 'installed').touch()
            if partial_venv:
                (root / 'venv' / 'bin').mkdir(parents=True)
                shutil.copyfile(binaries / 'python3.11', root / 'venv' / 'bin' / 'python')
                (root / 'venv' / 'bin' / 'python').chmod(0o755)
            apt = root / 'apt'
            (apt / 'sources.list.d').mkdir(parents=True)
            (apt / 'sources.list').write_text('deb http://cn.archive.ubuntu.com/ubuntu noble main\n')
            release = root / 'os-release'
            release.write_text(f'ID={distro}\nVERSION_ID={version}\nID_LIKE=""\n')
            certificate = root / 'ca-certificates.crt'
            certificate.write_text('isolated CA presence fixture', encoding='utf-8')
            source = SCRIPT.read_text(encoding='utf-8')
            markers = ('ID="unknown"; ID_LIKE=""; VERSION_ID="unknown"', 'PYV=', 'RUN_PY="$ROOT/venv/bin/python"',
                       '# Prepare Node, npm, and the default Pi runtime.')
            for marker in markers:
                self.assertEqual(source.count(marker), 1, 'installer fixture boundary changed: ' + marker)
            positions = [source.index(marker) for marker in markers]
            self.assertEqual(positions, sorted(positions), 'installer fixture boundaries changed order')
            selection = source[positions[0]:positions[1]]
            selection = selection.replace('/etc/os-release', shlex.quote(shell_path(release))).replace('/etc/apt/', shlex.quote(shell_path(apt)) + '/')
            for certificate_path in ('/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt'):
                selection = selection.replace(certificate_path, shlex.quote(shell_path(certificate)))
            dependencies = source[positions[2] + len(markers[2]):positions[3]]
            shell = '''set -euo pipefail
say() { echo "$*"; }
die() { echo "$*" >&2; exit 1; }
''' + selection + '\nRUN_PY="$ROOT/venv/bin/python"\n' + dependencies
            env = dict(os.environ, FIXTURE=temp, ROOT=shell_path(root),
                       PATH=f'{shell_path(binaries)}:/usr/bin:/bin')
            if cygpath:
                env.update(FIXTURE_CYGPATH=cygpath, MSYS2_ARG_CONV_EXCL='*')
            if fail_pip:
                env['FAIL_PIP'] = '1'
            result = subprocess.run([bash, '-c', shell], env=env,
                                    capture_output=True, text=True, encoding='utf-8', timeout=10)
            calls = [json.loads(line) for line in (root / 'calls').read_text().splitlines()] if (root / 'calls').exists() else []
            if result.returncode == 0 and distro == 'ubuntu' and any(name == 'apt-get' for name, _ in calls):
                self.assertIn('https://mirrors.tuna.tsinghua.edu.cn/ubuntu', (apt / 'sources.list').read_text())
                self.assertIn('cn.archive.ubuntu.com', (apt / 'sources.list.soduwork-backup').read_text())
            return result, calls

    def test_ubuntu_without_supported_python_installs_python_pip_and_venv(self):
        result, calls = self.bootstrap(supported=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        packages = [args for name, args in calls if name == 'apt-get']
        self.assertEqual(packages, [['update'], ['install', '-y', 'python3',
                                                'python3-venv', 'python3-pip']])
        install = [args for _, args in calls if args[:3] == ['-m', 'pip', 'install']]
        self.assertEqual(len(install), 1)
        self.assertIn('websockets>=15', install[0])
        self.assertIn('https://pypi.tuna.tsinghua.edu.cn/simple', install[0])

    def test_ubuntu_repairs_partial_venv_missing_pip(self):
        result, calls = self.bootstrap(partial_venv=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(['apt-get', ['install', '-y', 'python3.11', 'python3.11-venv', 'python3-pip']], calls)
        self.assertTrue(any('inspect.signature' in ' '.join(args) for _, args in calls))

    def test_el8_installs_side_by_side_python_without_replacing_system_python(self):
        result, calls = self.bootstrap('rocky', '8.10', supported=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(['dnf', ['install', '-y', 'python3.11', 'python3.11-pip']], calls)
        self.assertTrue(any(name == 'python3.11' and args[:2] == ['-m', 'venv']
                            for name, args in calls))

    def test_existing_environment_does_not_run_package_manager(self):
        result, calls = self.bootstrap(installed=True, partial_venv=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(name in ('apt-get', 'dnf') for name, _ in calls))

    def test_pip_failure_never_falls_back_to_importable_old_system_websockets(self):
        result, _ = self.bootstrap(installed=True, partial_venv=True, fail_pip=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Runner 依赖安装失败', result.stderr)

    def test_unsupported_distribution_explains_manual_prerequisites(self):
        result, calls = self.bootstrap('unknown', supported=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('暂不支持自动安装', result.stderr)
        self.assertFalse(any(name in ('apt-get', 'dnf') for name, _ in calls))


if __name__ == '__main__':
    unittest.main()
