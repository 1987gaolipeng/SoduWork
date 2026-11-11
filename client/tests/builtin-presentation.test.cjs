'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const packs = require('../core/locales/builtin-skills.js');
const pluginLocales = require('../core/plugin-locales.js');
const personal = require('../main/personal-plugins.js');
const root = path.resolve(__dirname, '..');

test('every bundled Skill has display metadata in all shipped locales without changing invocation identifiers', () => {
  const skillsRoot = path.resolve(root, '../skills');
  const names = fs.readdirSync(skillsRoot).flatMap(dir => {
    const file = path.join(skillsRoot, dir, 'SKILL.md');
    return fs.existsSync(file) ? [fs.readFileSync(file, 'utf8').match(/^name:\s*["']?([^\r\n"']+)/m)?.[1]].filter(Boolean) : [];
  });
  const profile = require('../../tools/distribution/PUBLIC-SOURCE.json');
  assert.deepEqual([...names].sort(), [...profile.skills].sort());
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
    const context = { SoduWorkI18n: { t: (key, fallback) => packs[locale][key] || fallback } };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'core/builtin-skill-presentation.js'), 'utf8'), context);
    for (const name of names) {
      const item = { name, builtIn: true, description: 'Original instructions' };
      for (const field of ['name', 'description']) {
        const key = 'builtin.skill.' + name + '.' + field;
        assert.ok(packs[locale][key], locale + ': ' + key);
        assert.equal(context.SoduWorkBuiltinSkills.text(item, field), packs[locale][key]);
      }
      assert.equal(item.name, name);
      assert.equal(item.description, 'Original instructions');
      assert.equal(context.SoduWorkBuiltinSkills.text({ ...item, builtIn: false }), name);
      assert.equal(context.SoduWorkBuiltinSkills.text({ ...item, sourceKey: 'company' }), name);
    }
  }
});

test('all shipped plugins localize presentation and retain executable configuration', () => {
  const app = { isPackaged: false, getAppPath: () => root, getPath: () => path.join(root, 'outputs/unused-builtin-fixture') };
  const rows = personal.catalog(app).filter(item => item.builtIn);
  assert.equal(rows.length, 5);
  for (const item of rows) {
    assert.ok(item.locales, item.key);
    for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
      const localized = pluginLocales.present(item, locale);
      assert.notEqual(localized.name, item.name, item.key + ' ' + locale);
      assert.notEqual(localized.description, item.description, item.key + ' description');
      assert.equal(localized.pluginId, item.pluginId);
      for (let i = 0; i < localized.inputs.length; i++) {
        const original = item.inputs[i], changed = localized.inputs[i];
        assert.equal(changed.key, original.key);
        assert.equal(changed.default, original.default);
        if (original.label) assert.notEqual(changed.label, original.label, item.key + ' ' + original.key);
      }
    }
  }
});
