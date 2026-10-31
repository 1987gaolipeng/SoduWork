"""Offline hosted declarations, portable packages and accepted-version MCP binding."""
import base64
import copy
import hashlib
import json
import subprocess
import unittest
import io
import zipfile
from pathlib import Path
from types import SimpleNamespace

from app.services import jiyong_contract, plugin_drafts, plugin_packages, plugin_application_mcp


class JiyongTests(unittest.TestCase):
    def body(self):
        return dict(extensions={'studio.future':{'schemaVersion':99,'unknown':{'labels':['未来',None,False]}}},author='即用实验室', appCategory='office', template='app', key='jiyong-notes', name='即用便签', version='0.1.0',
                    description='Hosted notes', instructions='Read and update real notes.',
                    mcpServers=['soduwork-jiyong'], entrypoints={'automation': True},
                    jiyong={'version': 1, 'parameters': [
                        {'key': 'serviceKey', 'type': 'string', 'display': 'hidden', 'secret': True},
                        {'key': 'theme', 'type': 'string', 'display': 'select', 'options': ['light', 'dark'], 'default': 'light'}],
                        'collections': [{'key': 'notes', 'indexes': ['status']}],
                        'mcp': {'server': 'soduwork-jiyong', 'bindings': []}},
                    ui={'contributions': [{'id': 'main', 'title': 'Notes', 'slot': 'workspace.navigation',
                         'source': {'type': 'package', 'entry': 'ui/index.html', 'bridge': {'version': 1,
                         'capabilities': ['data.read', 'data.write', 'mcp.connect', 'settings.read', 'settings.write']}}}]},
                    resources=[{'path': 'ui/index.html', 'kind': 'ui', 'encoding': 'base64',
                                'content': base64.b64encode(b'<!doctype html><title>Notes</title>').decode()}])

    def test_app_categories_are_portable_and_do_not_reuse_market_categories(self):
        from app.services import plugin_app_contracts
        for category in ('office', 'game', 'robot', 'other'):
            body=self.body();body['appCategory']=category
            parsed=plugin_packages.parse(plugin_drafts.build(body))
            self.assertEqual(plugin_packages.personal_draft(parsed)['appCategory'],category)
        self.assertEqual(plugin_app_contracts.category(None),'other')
        body=self.body();del body['appCategory']
        self.assertNotIn('appCategory',plugin_packages.parse(plugin_drafts.build(body))['manifest'])
        for category in ('web','unknown',[],{},True,123):
            body=self.body();body['appCategory']=category
            with self.subTest(category=category), self.assertRaises(ValueError):
                plugin_packages.parse(plugin_drafts.build(body))

    def test_client_and_hub_normalize_the_same_declaration(self):
        body = self.body()['jiyong']
        module = Path(__file__).resolve().parents[1] / 'client/core/jiyong-contract.cjs'
        result = subprocess.run(['node', '-e', 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>console.log(JSON.stringify(require(process.argv[1]).normalize(JSON.parse(s)))));', str(module)],
                                input=json.dumps(body), text=True, capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout), jiyong_contract.normalize(body))

    def test_draft_archive_and_personal_export_preserve_hosted_metadata(self):
        body = self.body()
        parsed = plugin_packages.parse(plugin_drafts.build(body))
        self.assertEqual(parsed['manifest']['jiyong'], jiyong_contract.normalize(body['jiyong']))
        draft = plugin_packages.personal_draft(parsed)
        self.assertEqual(draft['jiyong'], parsed['manifest']['jiyong'])
        again = plugin_packages.parse(plugin_drafts.build(draft))
        self.assertEqual(again['manifest']['jiyong'], parsed['manifest']['jiyong'])
        self.assertTrue(again['manifest']['entrypoints']['automation'])
        self.assertEqual(again['manifest']['author'], '即用实验室')
        self.assertEqual(again['manifest']['appCategory'], 'office')
        self.assertEqual(draft['appCategory'], 'office')
        self.assertEqual(again['manifest']['extensions'], body['extensions'])

    def test_initialization_script_survives_hub_import_reexport_and_missing_data_fails(self):
        body=self.body();body['jiyong']['initialization']={'script':'assets/data-init.json'}
        script={'schemaVersion':1,'migrations':[{'version':1,'seed':[{'collection':'notes','id':'welcome','value':{'title':'初始素材','status':'active'}}]}]}
        body['resources'].append({'path':'assets/data-init.json','kind':'asset','encoding':'base64','content':base64.b64encode(json.dumps(script).encode()).decode()})
        parsed=plugin_packages.parse(plugin_drafts.build(body));draft=plugin_packages.personal_draft(parsed)
        from app.services import jiyong_initialization
        self.assertEqual(jiyong_initialization.parse(draft['jiyong'],draft['resources']),script)
        again=plugin_packages.parse(plugin_drafts.build(draft));self.assertEqual(again['manifest']['jiyong']['initialization'],body['jiyong']['initialization'])
        body['resources'].pop()
        with self.assertRaises(ValueError):plugin_packages.parse(plugin_drafts.build(body))

    def test_secret_defaults_unknown_types_and_undeclared_connections_are_rejected(self):
        variants = []
        body = self.body(); body['jiyong']['parameters'][0]['default'] = 'example'; variants.append(body)
        body = self.body(); body['jiyong']['parameters'][1]['display'] = 'switch'; variants.append(body)
        body = self.body(); body['mcpServers'] = []; variants.append(body)
        body = self.body(); body['jiyong']['collections'][0]['indexes'] = ['escape.path']; variants.append(body)
        body = self.body(); body['jiyong']['unexpected'] = True; variants.append(body)
        body = self.body(); body['jiyong']['mcp']['bindings'] = [{'tool': 'data_get', 'argument': 'id', 'parameter': 'serviceKey'}]; variants.append(body)
        for body in variants:
            with self.subTest(body=body), self.assertRaises(ValueError):
                plugin_packages.parse(plugin_drafts.build(body))

    def test_large_multi_resource_client_export_survives_hub_import_and_reexport_without_truncation(self):
        body = self.body()
        files = {'ui/style.css': b'body{color:#123456}', 'ui/module.mjs': b'export const ready=true;',
                 'assets/material.bin': bytes(range(256)) * 200,
                 'references/usage.md': '真实技能，不是页面源码'.encode()}
        for name, content in files.items():
            body['resources'].append(dict(path=name, kind='ui' if name.startswith('ui/') else 'reference' if name.endswith('.md') else 'asset',
                                          encoding='base64', content=base64.b64encode(content).decode()))
        module = Path(__file__).resolve().parents[1] / 'client/main/personal-plugins.js'
        script = '''let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",async()=>{
          const p=require(process.argv[1]),fs=require('node:fs'),path=require('node:path');
          const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'jiyong-roundtrip-'));
          try {const app={getPath:()=>root},plugin=p.create(app,JSON.parse(s)).plugin;
            const file=path.join(root,'complete.soduwork-plugin');
            await p.exportToFile(app,{showSaveDialog:async()=>({filePath:file})},plugin.pluginId);
            process.stdout.write(fs.readFileSync(file));
          }catch(e){console.error(e);process.exitCode=1;}finally{fs.rmSync(root,{recursive:true,force:true});}
        });'''
        # The public client archive exporter and Hub builder both preserve all
        # bytes. The Hub path below is also used by admin upload and review.
        exported = subprocess.run(['node', '-e', script, str(module)], input=json.dumps(body).encode(), capture_output=True, check=True)
        packed = exported.stdout
        parsed = plugin_packages.parse(packed)
        draft = plugin_packages.personal_draft(parsed)
        again = plugin_packages.parse(plugin_drafts.build(draft))
        for result in [parsed, again]:
            resources = {row['path']: row for row in result['resources']}
            for name, expected in files.items():
                self.assertEqual(base64.b64decode(resources[name]['content']), expected)
                self.assertEqual(resources[name]['sha256'], hashlib.sha256(expected).hexdigest())
        broken = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(packed)) as source, zipfile.ZipFile(broken, 'w') as target:
            removed = False
            for item in source.infolist():
                if item.filename.endswith('/ui/style.css'):
                    removed = True
                    continue
                target.writestr(item, source.read(item))
        self.assertTrue(removed)
        with self.assertRaises(ValueError):
            plugin_packages.parse(broken.getvalue())

    def test_hosted_mcp_is_bound_to_the_actual_installed_version_origin_and_entry(self):
        manifest = plugin_packages.parse(plugin_drafts.build(self.body()))['manifest']
        version = SimpleNamespace(id='version-a', plugin_id='plugin-a', manifest=manifest,
                                  capability_report={'mcpServers': ['soduwork-jiyong']})
        origin = 'https://' + hashlib.sha256(b'plugin-a').hexdigest()[:32] + '.soduwork-app.invalid'
        bound = dict(pluginId='plugin-a', versionId='version-a', contributionId='main', origin=origin, server='soduwork-jiyong')
        self.assertEqual(plugin_application_mcp.validate(bound, version), 'soduwork-jiyong')
        self.assertEqual(plugin_application_mcp.company_names(manifest, ['soduwork-jiyong']), [])
        for patch in [{'versionId': 'new-version'}, {'origin': 'https://evil.invalid'}, {'contributionId': 'other'}, {'server': 'other'}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                plugin_application_mcp.validate({**bound, **patch}, version)
        wrong = copy.deepcopy(manifest); wrong.pop('jiyong')
        self.assertEqual(plugin_application_mcp.company_names(wrong, ['soduwork-jiyong']), ['soduwork-jiyong'])


if __name__ == '__main__':
    unittest.main()
