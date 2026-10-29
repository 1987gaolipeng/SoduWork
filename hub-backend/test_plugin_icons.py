import base64
import json
import subprocess
import unittest
from pathlib import Path
from app.services import plugin_icons, plugin_packages, plugin_drafts

PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxqkAAAAASUVORK5CYII='


class PluginIconTests(unittest.TestCase):
    def test_safe_bounded_contract(self):
        self.assertEqual(plugin_icons.normalize(PNG), PNG)
        self.assertEqual(plugin_icons.normalize(None), '')
        for value in ['https://example.com/logo.png', 'file:///private.png',
                      'data:image/svg+xml,<svg/>', {}, 'data:image/png;base64,AAAA',
                      PNG + 'A', 'data:image/png;base64,' + 'A' * 140000]:
            with self.subTest(value=str(value)[:60]):
                with self.assertRaises(ValueError): plugin_icons.normalize(value)
                self.assertEqual(plugin_icons.public(value), '')
        data = bytearray(base64.b64decode(PNG.split(',')[1]))
        data[16:20] = (257).to_bytes(4, 'big')
        with self.assertRaises(ValueError):
            plugin_icons.normalize('data:image/png;base64,' + base64.b64encode(data).decode())

    def test_local_export_publish_package_and_reimport_keep_icon(self):
        body = dict(template='method', key='icon-demo', name='图标演示', version='1.0.0',
                    description='图标保存验证', instructions='整理工作进展。', icon=PNG)
        script = "const p=require('./client/main/personal-plugins');let x='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>x+=s);process.stdin.on('end',()=>console.log(JSON.stringify(p.build(JSON.parse(x)))));"
        result = subprocess.run(['node', '-e', script], input=json.dumps(body), text=True,
                                encoding='utf8', capture_output=True, check=True,
                                cwd=Path(__file__).resolve().parent.parent)
        local = json.loads(result.stdout)
        self.assertEqual(local['manifest']['icon'], PNG)
        parsed = plugin_packages.parse(plugin_drafts.build(local['body']))
        self.assertEqual(parsed['manifest']['icon'], PNG)
        restored = plugin_packages.personal_draft(parsed)
        self.assertEqual(restored['icon'], PNG)
        again = plugin_packages.parse(plugin_drafts.build(restored))
        self.assertEqual(again['manifest']['icon'], PNG)
        del body['icon']
        default = plugin_packages.parse(plugin_drafts.build(body))
        self.assertNotIn('icon', default['manifest'])
        self.assertNotIn('icon', plugin_packages.personal_draft(default))
        self.assertNotEqual(parsed['checksum'], default['checksum'])


if __name__ == '__main__': unittest.main()
