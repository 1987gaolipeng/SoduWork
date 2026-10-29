import base64
import hashlib
import io
import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from app.services import plugin_resources as resources, plugin_drafts, plugin_packages


def draft():
    return dict(template='method', key='template-demo', name='模板演示', version='1.0.0',
                description='使用随包模板', instructions='复制模板并交付报告。', resources=[
                    dict(path='templates/报告.md', kind='template', encoding='utf8', content='# {{title}}\n'),
                    dict(path='scripts/render.py', kind='script', encoding='utf8', content='print("sample")')])


class PluginResourcesTests(unittest.TestCase):
    def test_runner_rejects_changed_resources_even_when_stored_version_checksum_is_unchanged(self):
        from app.services import personal_plugin_runtime
        body=draft()
        rows=resources.normalize(body['resources'])
        version=dict(version='1.0.0',checksum='fixed-checksum',body={**body,'resources':rows},
                     manifest={'resources':resources.summary(rows)})
        state={'plugins':[dict(key=body['key'],currentVersion='1.0.0',versions=[version])]}
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'plugins.json'
            file.write_text(json.dumps(state),encoding='utf8')
            loaded=personal_plugin_runtime.load_plugin(body['key'],str(file))
            self.assertEqual(loaded['resources'],rows)
            version['body']['resources']=resources.normalize([
                dict(path='templates/replaced.md',kind='template',encoding='utf8',content='replaced')])
            file.write_text(json.dumps(state),encoding='utf8')
            with self.assertRaisesRegex(ValueError,'版本清单不一致'):
                personal_plugin_runtime.load_plugin(body['key'],str(file))

    def test_frontend_backend_contract_agree(self):
        script = "const r=require('./client/main/plugin-resources');let x='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>x+=s);process.stdin.on('end',()=>{const rows=r.normalize(JSON.parse(x));console.log(JSON.stringify({rows,digest:r.digest(rows)}))});"
        result = subprocess.run(['node', '-e', script], input=json.dumps(draft()['resources']),
                                text=True, encoding='utf8', capture_output=True, check=True,
                                cwd=Path(__file__).resolve().parent.parent)
        got = json.loads(result.stdout)
        expected = resources.normalize(draft()['resources'])
        self.assertEqual(got['rows'], expected)
        self.assertEqual(got['digest'], resources.digest(expected))

    def test_build_parse_reimport_preserves_bytes_and_reviewed_hashes(self):
        body=draft(); package=plugin_drafts.build(body); parsed=plugin_packages.parse(package)
        self.assertEqual(parsed['manifest']['resources'],resources.summary(resources.normalize(body['resources'])))
        with zipfile.ZipFile(io.BytesIO(package)) as z:
            self.assertEqual(z.read('skills/template-demo/templates/报告.md'),b'# {{title}}\n')
        restored=plugin_packages.personal_draft(parsed)
        self.assertEqual(restored['resources'],resources.normalize(body['resources']))
        self.assertEqual(parsed['capabilities']['resources'],parsed['manifest']['resources'])

    def test_mutated_or_missing_resource_cannot_pass_package_validation(self):
        original=plugin_drafts.build(draft())
        for mode in ('mutate','missing'):
            out=io.BytesIO()
            with zipfile.ZipFile(io.BytesIO(original)) as source, zipfile.ZipFile(out,'w') as dest:
                for name in source.namelist():
                    data=source.read(name)
                    if name.endswith('报告.md'):
                        if mode=='missing': continue
                        data=b'wrong-content'
                    dest.writestr(name,data)
            with self.assertRaises(ValueError): plugin_packages.parse(out.getvalue())

    def test_path_secret_size_and_encoding_boundaries(self):
        for name in ['../a','assets/../a','assets\\a','/assets/a','assets/CON.txt','assets/a:stream','assets/.env','assets/a.exe']:
            with self.assertRaises(ValueError): resources.normalize([dict(path=name,kind='asset',encoding='utf8',content='x')])
        item=dict(path='assets/a.txt',kind='asset',encoding='utf8',content='password=abcdefghi')
        with self.assertRaises(ValueError): resources.normalize([item])
        with self.assertRaises(ValueError): resources.normalize([{**item,'encoding':'base64','content':'eA'}])
        with self.assertRaises(ValueError): resources.normalize([{**item,'content':'x','sha256':'0'*64}])

    def test_materialize_and_execute_fixture_uses_real_packaged_files(self):
        body=draft(); body['resources'][1]['content']='from pathlib import Path\nprint((Path(__file__).parent.parent / "templates" / "报告.md").read_text(encoding="utf8").replace("{{title}}", "READY"))'
        with tempfile.TemporaryDirectory() as root:
            bundle=resources.materialize(body['resources'],root,body['key'])
            file=Path(bundle['directory'])/'scripts/render.py'
            import sys
            output=subprocess.run([sys.executable,str(file)],capture_output=True,text=True,encoding='utf8',check=True)
            self.assertIn('# READY',output.stdout)
            self.assertEqual(resources.materialize(body['resources'],root,body['key'])['digest'],bundle['digest'])
            file.write_text('modified',encoding='utf8')
            repaired=resources.materialize(body['resources'],root,body['key'])
            self.assertEqual(file.read_text(encoding='utf8'),body['resources'][1]['content'])
            self.assertEqual(repaired['rescued'],['scripts/render.py'])
            saved=Path(bundle['directory'])/repaired['backups'][0]['backup']
            self.assertEqual(saved.read_text(encoding='utf8'),'modified')


if __name__ == '__main__': unittest.main()
