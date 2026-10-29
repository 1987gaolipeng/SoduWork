"""Execute installer bootstrap with isolated OS/package-manager fixtures."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).parent / 'installers' / 'runner-install.sh'

# Fake only machine/package boundaries; bash executes the production branches.
TOOL = r'''#!PYTHON
import json, os, pathlib, sys
root = pathlib.Path(os.environ['FIXTURE'])
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with (root / 'calls').open('a') as f:
    f.write(json.dumps([name, args]) + '\n')
if name in ('apt-get', 'dnf', 'yum'):
    (root / 'installed').touch()
    sys.exit(0)
if name == 'id':
    print(0)
    sys.exit(0)
is_venv = 'venv' in sys.argv[0]
installed = (root / 'installed').exists()
if args[:2] == ['-m', 'venv']:
    if not installed:
        sys.exit(1)
    target = pathlib.Path(args[2]) / 'bin'
    target.mkdir(parents=True, exist_ok=True)
    py = target / 'python'
    if not py.exists():
        py.symlink_to(root / 'bin' / 'python3.11')
    sys.exit(0)
if args[:2] == ['-m', 'pip']:
    if not is_venv or not installed:
        sys.exit(1)
    if 'install' in args and os.environ.get('FAIL_PIP'):
        sys.exit(1)
    sys.exit(0)
if args[0] == '-c':
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
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            binaries = root / 'bin'
            binaries.mkdir()
            tool = binaries / 'python3.11'
            tool.write_text(TOOL.replace('PYTHON', sys.executable, 1))
            tool.chmod(0o755)
            for name in ('python3', 'python3.14', 'python3.13', 'python3.12', 'python3.10', 'apt-get', 'dnf', 'id'):
                (binaries / name).symlink_to(tool)
            if supported:
                (root / 'supported').touch()
            if installed:
                (root / 'installed').touch()
            if partial_venv:
                (root / 'venv' / 'bin').mkdir(parents=True)
                (root / 'venv' / 'bin' / 'python').symlink_to(tool)
            apt = root / 'apt'
            (apt / 'sources.list.d').mkdir(parents=True)
            (apt / 'sources.list').write_text('deb http://cn.archive.ubuntu.com/ubuntu noble main\n')
            release = root / 'os-release'
            release.write_text(f'ID={distro}\nVERSION_ID={version}\nID_LIKE=""\n')
            source = SCRIPT.read_text()
            selection = source[source.index('ID="unknown"'):].split('PYV=', 1)[0]
            selection = selection.replace('/etc/os-release', str(release)).replace('/etc/apt/', str(apt) + '/')
            dependencies = source.split('RUN_PY="$ROOT/venv/bin/python"', 1)[1].split(
                '# ---------------------------------------------------------------- 3.', 1)[0]
            shell = '''set -euo pipefail
say() { echo "$*"; }
die() { echo "$*" >&2; exit 1; }
''' + selection + '\nRUN_PY="$ROOT/venv/bin/python"\n' + dependencies
            env = dict(os.environ, FIXTURE=temp, ROOT=temp,
                       PATH=f'{binaries}:/usr/bin:/bin')
            if fail_pip:
                env['FAIL_PIP'] = '1'
            result = subprocess.run(['bash', '-c', shell], env=env,
                                    capture_output=True, text=True, timeout=10)
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
