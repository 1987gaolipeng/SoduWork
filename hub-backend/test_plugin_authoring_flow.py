"""Offline authoring -> archive -> personal installation contracts, no Hub DB."""
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from app.services import plugin_drafts, plugin_packages, personal_plugin_runtime


def draft():
    return dict(template='connector', key='team-brief', name='团队简报', version='1.0.0',
                description='汇总资料生成简报', instructions='按模板汇总并交付报告。',
                platforms=['wecom', 'dingtalk'], setup={'preferences': [
                    dict(key='department', label='部门', type='text', required=True)]},
                resources=[dict(path='templates/brief.md', kind='template',
                                encoding='utf8', content='# Brief')])


class AuthoringFlowTests(unittest.TestCase):
    def test_archive_roundtrip_preserves_setup_ui_platforms_and_full_resources(self):
        body = draft()
        body['ui'] = {'contributions': [dict(id='reference', title='参考', slot='task.detail.tab',
                                            source={'type': 'external', 'url': 'https://example.invalid/report'})]}
        parsed = plugin_packages.parse(plugin_drafts.build(body))
        restored = plugin_packages.personal_draft(parsed)
        self.assertEqual(restored['platforms'], body['platforms'])
        self.assertEqual(restored['template'], 'connector')
        self.assertEqual(restored['setup'], parsed['manifest']['setup'])
        self.assertEqual(restored['ui'], parsed['manifest']['ui'])
        self.assertEqual(restored['entrypoints'], parsed['manifest']['entrypoints'])
        rebuilt = plugin_packages.parse(plugin_drafts.build(restored))
        self.assertEqual(rebuilt['manifest']['resources'], parsed['manifest']['resources'])
        self.assertEqual(rebuilt['capabilities']['platforms'], body['platforms'])

    def test_cli_connector_without_mcp_is_valid_and_empty_connector_is_rejected(self):
        body = draft()
        del body['platforms']
        with self.assertRaises(ValueError):
            plugin_drafts.build(body)
        body['runtimeCapabilities'] = ['terminal']
        body['resources'].append(dict(path='scripts/query.py', kind='script',
                                      encoding='utf8', content='print("fixture")'))
        package = plugin_drafts.build(body)
        parsed = plugin_packages.parse(package)
        self.assertTrue(parsed['manifest']['capabilities']['network'])
        self.assertEqual(plugin_packages.personal_draft(parsed)['template'], 'connector')
        with zipfile.ZipFile(io.BytesIO(package)) as archive:
            self.assertTrue(any(name.endswith('scripts/query.py') for name in archive.namelist()))

    def test_feishu_includes_personal_mcp_and_unknown_platform_is_rejected(self):
        body = draft()
        body['platforms'] = ['feishu']
        parsed = plugin_packages.parse(plugin_drafts.build(body))
        self.assertIn('feishu', parsed['capabilities']['mcpServers'])
        self.assertIn('terminal', parsed['capabilities']['runtime'])
        body['platforms'] = ['unknown']
        with self.assertRaises(ValueError):
            plugin_drafts.build(body)

    def test_personal_runner_reads_version_bound_preferences_and_blocks_missing(self):
        body = draft()
        body.pop('resources')
        version = dict(version='1.0.0', checksum='abc', body=body, manifest={'setup': body['setup']})
        plugin = dict(key=body['key'], currentVersion='1.0.0', versions=[version])
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / 'plugins.json'
            target.write_text(json.dumps({'plugins': [plugin]}), encoding='utf8')
            with self.assertRaisesRegex(ValueError, '设置中完成配置'):
                personal_plugin_runtime.load_plugin(body['key'], str(target))
            plugin['setupByVersion'] = {'abc': {'department': '研发'}}
            target.write_text(json.dumps({'plugins': [plugin]}), encoding='utf8')
            loaded = personal_plugin_runtime.load_plugin(body['key'], str(target))
            self.assertEqual(loaded['_soduworkSetupConfig'], {'department': '研发'})
            self.assertIn('研发', personal_plugin_runtime.context_text(loaded, []))
            self.assertNotIn('_soduworkSetupConfig', body)


if __name__ == '__main__':
    unittest.main()
