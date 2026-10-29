"""Offline portable window metadata, including build/parse/export round trips."""
import unittest
from app.services import plugin_drafts, plugin_packages, plugin_window_contracts


class PluginWindowTests(unittest.TestCase):
    def test_window_metadata_roundtrip_and_omission(self):
        body = dict(template='method', key='window-fixture', name='窗口样例', version='1.0.0',
                    description='应用窗口默认值', instructions='显示工作页面。')
        parsed = plugin_packages.parse(plugin_drafts.build(body))
        self.assertNotIn('appWindow', parsed['manifest'])
        body['appWindow'] = {}
        defaults = plugin_packages.parse(plugin_drafts.build(body))['manifest']['appWindow']
        self.assertEqual((defaults['width'], defaults['height']), ('1800px', '1125px'))
        body['appWindow'] = dict(width='90vw', height='80vh', maxWidth=2680, maxHeight=17800,
                                 rules=[dict(maxScreenWidth=1366, width='100vw', height='100vh')])
        expected = plugin_window_contracts.normalize(body['appWindow'])
        parsed = plugin_packages.parse(plugin_drafts.build(body))
        self.assertEqual(parsed['manifest']['appWindow'], expected)
        draft = plugin_packages.personal_draft(parsed)
        self.assertEqual(draft['appWindow'], expected)
        self.assertEqual(plugin_packages.parse(plugin_drafts.build(draft))['manifest']['appWindow'], expected)

    def test_invalid_author_config_is_rejected(self):
        for value in [False, [], '100vw', dict(width='calc(100vw)'), dict(width=0),
                      dict(minWidth=900, maxWidth=800), dict(rules=[dict(width=800, minScreenWidth=2000, maxScreenWidth=1000)])]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                plugin_window_contracts.normalize(value)
        self.assertIsNone(plugin_window_contracts.public(dict(width='bad')))
        self.assertIsNone(plugin_window_contracts.normalize(None))


if __name__ == '__main__':
    unittest.main()
