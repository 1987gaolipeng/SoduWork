"""Execute generated enrollment commands against fake host boundaries."""
import ast
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SOURCE = Path(__file__).parent / 'app/services/runner_enroll.py'
TREE = ast.parse(SOURCE.read_text(encoding='utf-8'))
FUNCTIONS = ast.Module(body=[n for n in TREE.body if isinstance(n, ast.FunctionDef)
                            and n.name in ('install_commands', '_quote_sh', '_quote_ps')],
                       type_ignores=[])
NAMESPACE = {'validate_hub_url': lambda hub: hub}
exec(compile(FUNCTIONS, str(SOURCE), 'exec'), NAMESPACE)

TOOL = r'''#!PYTHON
import json,os,pathlib,sys
root=pathlib.Path(os.environ['FIXTURE'])
name=pathlib.Path(sys.argv[0]).name
args=sys.argv[1:]
with (root/'calls').open('a') as f:f.write(json.dumps([name,args])+'\n')
if name=='id':print(os.environ.get('FIXTURE_UID','0'))
elif name=='sudo':
 if os.environ.get('FAIL_SUDO'):sys.exit(1)
 os.execv(str(root/'bash'),['bash',*args[2:]])
elif name=='bash':
 if args[0]=='-c':os.execv('/bin/bash',['bash',*args])
 (root/'installed').write_text(json.dumps(args[1:]))
elif name=='curl':
 if os.environ.get('FAIL_DOWNLOAD'):sys.exit(22)
 pathlib.Path(args[-1]).write_text('# fixture installer\n')
elif name=='apt-get':
 if args[0]=='install':(root/'curl').symlink_to(root/'tool')
'''


@unittest.skipUnless(os.name == 'posix' and Path('/bin/bash').is_file(),
                     'Enrollment shell fixture requires a native POSIX host and /bin/bash')
class EnrollmentCommandTests(unittest.TestCase):
    def run_command(self, *, uid='0', missing_curl=False, fail_download=False,
                    deny_sudo=False):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            tool=root/'tool'
            tool.write_text(TOOL.replace('PYTHON',sys.executable,1))
            tool.chmod(0o755)
            names=['bash','id','sudo','apt-get'] + ([] if missing_curl else ['curl'])
            for name in names:(root/name).symlink_to(tool)
            for name in ('mktemp','rm','cp','sed'):(root/name).symlink_to('/usr/bin/'+name)
            apt=root/'apt'
            (apt/'sources.list.d').mkdir(parents=True)
            (apt/'sources.list').write_text('deb http://archive.ubuntu.com/ubuntu noble main\n')
            release=root/'os-release'
            release.write_text('ID=ubuntu\n')
            injection=root/'must-not-exist'
            work=f"/work/quote' $(touch {injection})"
            key="fixture-key'with-quotes"
            command=NAMESPACE['install_commands']('https://fixture.invalid','fixture',key,
                                                 ['linux','tag with spaces'],work)['linux']
            command=command.replace('/etc/os-release',str(release)).replace('/etc/apt/',str(apt)+'/')
            env=dict(os.environ,PATH=temp,FIXTURE=temp,FIXTURE_UID=uid,TMPDIR=temp)
            if fail_download:env['FAIL_DOWNLOAD']='1'
            if deny_sudo:env['FAIL_SUDO']='1'
            result=subprocess.run(['/bin/bash','-c',command],env=env,capture_output=True,
                                  text=True,timeout=10)
            calls=[json.loads(line) for line in (root/'calls').read_text().splitlines()]
            installed=json.loads((root/'installed').read_text()) if (root/'installed').exists() else None
            self.assertFalse(injection.exists())
            for name,args in calls:
                if name=='curl':self.assertFalse(Path(args[-1]).exists(), 'installer is removed on success or failure')
            if missing_curl and result.returncode == 0:
                self.assertIn('mirrors.tuna.tsinghua.edu.cn', (apt/'sources.list').read_text())
            return result,calls,installed,work,key

    def test_root_entry_does_not_require_sudo_and_preserves_quoted_arguments(self):
        result,calls,args,work,key=self.run_command()
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertFalse(any(name=='sudo' for name,_ in calls))
        self.assertEqual(args[:4],['--hub','https://fixture.invalid','--id','fixture'])
        self.assertEqual(args[args.index('--key')+1],key)
        self.assertEqual(args[args.index('--work-root')+1],work)
        self.assertEqual(args[args.index('--tags')+1],'linux,tag with spaces')

    def test_nonroot_entry_uses_noninteractive_sudo(self):
        result,calls,args,work,key=self.run_command(uid='1000')
        self.assertEqual(result.returncode,0,result.stderr)
        sudo=next(args for name,args in calls if name=='sudo')
        self.assertEqual(sudo[:2],['-n','bash'])
        self.assertEqual(args[:4],['--hub','https://fixture.invalid','--id','fixture'])
        self.assertEqual(args[args.index('--key')+1],key)
        self.assertEqual(args[args.index('--work-root')+1],work)

    def test_denied_sudo_stops_before_downloading_or_running_an_installer(self):
        result,calls,args,_,_=self.run_command(uid='1000',deny_sudo=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIsNone(args)
        self.assertFalse(any(name in ('curl','apt-get') for name,_ in calls))

    def test_minimal_ubuntu_bootstraps_curl_before_downloading(self):
        result,calls,args,_,_=self.run_command(missing_curl=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIsNotNone(args)
        self.assertIn(['apt-get',['install','-y','curl','ca-certificates']],calls)

    def test_download_failure_never_runs_an_empty_installer(self):
        result,_,args,_,_=self.run_command(fail_download=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIsNone(args)


if __name__=='__main__':unittest.main()
