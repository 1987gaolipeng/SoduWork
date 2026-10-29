"""Offline app discriminator checks across draft, archive and personal import."""
import copy
import base64
import unittest
from app.services import plugin_drafts, plugin_packages


class PluginAppTests(unittest.TestCase):
    def static_body(self):
        body = self.body()
        body['ui']['contributions'][0]['source'] = {
            'type': 'package', 'entry': 'ui/index.html', 'bridge': {'version': 1,
                'capabilities': ['conversation.send', 'composer.control']}}
        body['resources'] = [{'path': 'ui/index.html', 'kind': 'ui', 'encoding': 'base64',
                              'content': base64.b64encode(b'<!doctype html><title>Offline</title>').decode()}]
        return body

    def test_static_h5_entry_roundtrips_with_its_declared_resources(self):
        body = self.static_body()
        parsed = plugin_packages.parse(plugin_drafts.build(body))
        source = parsed['manifest']['ui']['contributions'][0]['source']
        self.assertEqual(source['type'], 'package')
        self.assertEqual(source['entry'], 'ui/index.html')
        self.assertNotIn('url', source)
        imported = plugin_packages.personal_draft(parsed)
        self.assertEqual(plugin_packages.parse(plugin_drafts.build(imported))['manifest']['ui'], parsed['manifest']['ui'])

    def test_static_h5_rejects_escaping_missing_or_non_html_entry(self):
        for entry in ('../index.html', 'ui/../index.html', '/ui/index.html', 'ui/index.js',
                      'file:///private.html', 'ui/%2e%2e/index.html', 'ui/missing.html'):
            body = self.static_body()
            body['ui']['contributions'][0]['source']['entry'] = entry
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                plugin_packages.parse(plugin_drafts.build(body))

    def test_cover_survives_draft_archive_and_reimport(self):
        body = self.body()
        body['coverUrl'] = 'https://example.invalid/cover.jpg'
        parsed = plugin_packages.parse(plugin_drafts.build(body))
        self.assertEqual(parsed['manifest']['coverUrl'], body['coverUrl'])
        self.assertEqual(plugin_packages.personal_draft(parsed)['coverUrl'], body['coverUrl'])
        for value in ['javascript:alert(1)', 'file:///private.png', 'https://user:secret@example.com/image.png', 'https://example.com/a b']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                plugin_drafts.build({**body, 'coverUrl': value})

    def test_direct_automation_is_an_explicit_optional_bridge_capability(self):
        body = self.body()
        body['ui']['contributions'][0]['source']['bridge']['capabilities'].append('automation.create')
        parsed = plugin_packages.parse(plugin_drafts.build(body))
        capabilities = parsed['manifest']['ui']['contributions'][0]['source']['bridge']['capabilities']
        self.assertIn('automation.create', capabilities)
        self.assertFalse(parsed['manifest']['entrypoints']['automation'])

    def body(self):
        return dict(template='app', key='app-fixture', name='应用', version='1.0.0',
                    description='应用类型贯通', instructions='处理当前应用的工作。',
                    ui=dict(contributions=[dict(id='main', title='应用', slot='workspace.navigation',
                            source=dict(type='external', openMode='workspace', url='https://example.invalid/',
                                        bridge=dict(version=1, capabilities=['conversation.send', 'composer.control', 'settings.read', 'settings.write', 'mcp.connect'])))]))

    def test_type_roundtrips_without_becoming_connector(self):
        body = self.body()
        body['mcpServers'] = ['real-business']
        parsed = plugin_packages.parse(plugin_drafts.build(body))
        self.assertEqual(parsed['manifest']['template'], 'app')
        self.assertTrue(parsed['capabilities']['network'])
        self.assertFalse(parsed['manifest']['entrypoints']['automation'])
        draft = plugin_packages.personal_draft(parsed)
        self.assertEqual(draft['template'], 'app')
        self.assertEqual(plugin_packages.parse(plugin_drafts.build(draft))['manifest']['template'], 'app')

    def test_requires_owned_workspace_page(self):
        for change in ('missing', 'external', 'credential'):
            body = copy.deepcopy(self.body())
            if change == 'missing':
                del body['ui']
            elif change == 'external':
                body['ui']['contributions'][0]['source']['openMode'] = 'external'
            else:
                body['ui']['contributions'][0]['source']['url'] = 'https://user:pass@example.invalid/'
            with self.subTest(change=change), self.assertRaises(ValueError):
                plugin_drafts.build(body)

    def test_legacy_ui_plugin_keeps_implicit_type(self):
        body = self.body()
        body['template'] = 'method'
        parsed = plugin_packages.parse(plugin_drafts.build(body))
        self.assertNotIn('template', parsed['manifest'])


if __name__ == '__main__':
    unittest.main()
