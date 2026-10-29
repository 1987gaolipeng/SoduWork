"""Locale metadata survives governed package parsing without changing execution."""
import copy
import unittest
from app.services import plugin_drafts, plugin_locales, plugin_packages


class PluginLocalesTests(unittest.TestCase):
    def body(self):
        return dict(template='method', key='locale-fixture', name='兼容名称', version='1.0.0',
                    description='兼容描述', instructions='处理明确要求的当前工作。',
                    locales={'zh-CN': {'name': '中文名', 'description': '中文说明'},
                             'en-US': {'name': 'English name', 'description': 'English description',
                                       'inputs': {'mode': {'label': 'Mode', 'options': {'auto': 'Automatic'}}}},
                             'ko-KR': {'name': '운영'}})

    def test_package_and_personal_draft_roundtrip(self):
        body = self.body()
        parsed = plugin_packages.parse(plugin_drafts.build(body))
        expected = plugin_locales.normalize(body['locales'])
        self.assertEqual(parsed['manifest']['locales'], expected)
        draft = plugin_packages.personal_draft(parsed)
        self.assertEqual(draft['locales'], expected)
        rebuilt = plugin_packages.parse(plugin_drafts.build(draft))
        self.assertEqual(rebuilt['manifest']['locales'], expected)
        del body['locales']
        legacy = plugin_packages.parse(plugin_drafts.build(body))
        self.assertNotIn('locales', legacy['manifest'])
        self.assertEqual(legacy['workflow'], parsed['workflow'])
        self.assertEqual(legacy['manifest']['capabilities'], parsed['manifest']['capabilities'])

    def test_rejects_invalid_or_executable_translations(self):
        source = self.body()['locales']
        invalid = [{}, {'en': source['en-US']}, {**source, 'en_US': source['en-US']},
                   {**source, 'ko': {'instructions': 'override'}},
                   {**source, 'ko': {'ui': {'main': {'source': {'url': 'https://evil.invalid'}}}}},
                   {**source, 'ko': {'inputs': {'mode': {'default': 'altered'}}}},
                   {**source, 'ko': {'ui': {'__proto__': {'title': 'bad'}}}}]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                plugin_drafts.build({**self.body(), 'locales': copy.deepcopy(value)})


if __name__ == '__main__':
    unittest.main()
