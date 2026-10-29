"""Real skill creation/import/scanning contracts; isolated files, no model calls."""
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import yaml

from app.services import plugin_adapters, plugin_drafts, skill_packages, skills


def archive(content, path="fixture/SKILL.md"):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as package:
        package.writestr(path, content)
    return stream.getvalue()


def document(fields, body="Keep the full task body.\n"):
    return "---\n" + fields + "\n---\n\n" + body


class SkillFrontmatterTests(unittest.TestCase):
    def test_create_serializes_description_without_changing_content(self):
        for description in ['Evidence: preserve logs', 'A # literal comment',
                            '"Quoted" and \\ paths', '第一行\n第二行: 要求',
                            'on', '2026-10-15', 'one\u0085two', 'one\u2028two', 'one\u2029two',
                            'escaped\u007f\u0080\u009fcontrol']:
            with self.subTest(description=description):
                parsed = skill_packages.create("debug-radar", description, "Body\nFull tail")
                text = parsed["files"]["SKILL.md"].decode()
                actual = yaml.safe_load(text.split("---", 2)[1])
                self.assertEqual(actual["description"], description)
                self.assertEqual(parsed["description"], description)
                self.assertTrue(text.endswith("Body\nFull tail\n"))

    def test_plugin_draft_serializes_description(self):
        description = 'Evidence: preserve # logs\n"Second line"'
        data = plugin_drafts.build({"template": "method", "name": "Debug radar",
                                    "key": "debug-radar", "description": description,
                                    "instructions": "Preserve the full body."})
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            text = package.read("skills/debug-radar/SKILL.md").decode()
            actual = yaml.safe_load(text.split("---", 2)[1])
        self.assertEqual(actual["description"], description)

    def test_all_importers_reject_invalid_yaml_with_internal_path(self):
        bad_fields = [
            'description: Evidence: preserve logs',
            'description: First\ndescription: Second',
            'description: [one, two]', 'description: {task: value}',
            'description: true', 'description: 42', 'description: null',
            'description: !!python/object/apply:os.system [echo forbidden]',
            'description: good\nmetadata: &self {loop: *self}',
            'description: good\nmetadata: &meta [a, b]\ncopy: *meta',
            'description: good\nmetadata: {a: 1, a: 2}',
            'description: good\ncompatibility: [node]',
            'description: good\nmetadata: {? [one, two]: x}',
        ]
        for fields in bad_fields:
            raw = document("name: debug-radar\n" + fields)
            with self.subTest(fields=fields, entry="skill"):
                with self.assertRaisesRegex(ValueError, "fixture/SKILL.md"):
                    skill_packages.parse(archive(raw))
            with self.subTest(fields=fields, entry="plugin"):
                with zipfile.ZipFile(io.BytesIO(archive(raw, "skills/fixture/SKILL.md"))) as package:
                    names = {info.filename: info for info in package.infolist()}
                    with self.assertRaisesRegex(ValueError, "skills/fixture/SKILL.md"):
                        plugin_adapters.discover_skills(package, names)

    def test_valid_yaml_variants_have_same_description_in_import_and_scan(self):
        samples = [('description: >-\n  First line\n  Second line', 'First line Second line'),
                   ('description: |\n  First line\n  Second line', 'First line\nSecond line\n'),
                   ('description: "Evidence: preserve # logs"', 'Evidence: preserve # logs'),
                   ("description: 'It''s a skill'", "It's a skill"),
                   ('description: on', 'on'), ('description: 2026-10-15', '2026-10-15')]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "SKILL.md"
            for fields, expected in samples:
                with self.subTest(fields=fields):
                    raw = document("name: debug-radar\n" + fields)
                    path.write_text(raw, encoding="utf-8")
                    self.assertEqual(skill_packages.parse(archive(raw))["description"], expected)
                    self.assertEqual(skills._parse_front(str(path))["description"], expected)

    def test_scan_rejects_broken_yaml_and_invalid_utf8(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "SKILL.md"
            for raw in [document("name: bad\ndescription: foo: bar").encode(),
                        document("name: bad\ndescription: \ufffd").encode().replace(b'\xef\xbf\xbd', b'\xff')]:
                with self.subTest(raw=raw):
                    path.write_bytes(raw)
                    self.assertIsNone(skills._parse_front(str(path)))
                    with zipfile.ZipFile(io.BytesIO(archive(raw, "skills/bad/SKILL.md"))) as package:
                        with self.assertRaisesRegex(ValueError, "skills/bad/SKILL.md"):
                            plugin_adapters.discover_skills(package, {x.filename: x for x in package.infolist()})

    def test_create_rejects_overlong_description_instead_of_truncating(self):
        with self.assertRaisesRegex(ValueError, "description|描述"):
            skill_packages.create("fixture", "x" * 1025, "Complete instructions")

    def test_create_rejects_name_injection_without_reinterpreting_input(self):
        for name in ["debug-radar\nunexpected: yes", "debug-radar # hidden suffix",
                     "debug-radar\ncompatibility: injected"]:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "name"):
                skill_packages.create(name, "Valid description", "Keep complete instructions")

    def test_create_preserves_allowed_names_that_are_yaml_scalars(self):
        for name in ["123", "null", "true", "false"]:
            with self.subTest(name=name):
                parsed = skill_packages.create(name, "Valid description", "Instructions")
                self.assertEqual(parsed["name"], name)

    def test_plugin_draft_preserves_key_that_is_yaml_scalar(self):
        for key in ["null", "true", "false"]:
            with self.subTest(key=key):
                data = plugin_drafts.build({"template": "method", "name": "Fixture",
                                            "key": key, "description": "Description",
                                            "instructions": "Instructions"})
                with zipfile.ZipFile(io.BytesIO(data)) as package:
                    text = package.read(f"skills/{key}/SKILL.md").decode()
                self.assertEqual(yaml.safe_load(text.split("---", 2)[1])["name"], key)

    def test_missing_description_still_not_scanned(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "SKILL.md"
            path.write_text(document("name: fixture"), encoding="utf-8")
            self.assertIsNone(skills._parse_front(str(path)))

    def test_packaged_skill_requires_name_but_local_directory_can_supply_it(self):
        raw = document("description: Valid standalone skill")
        with self.assertRaisesRegex(ValueError, "name"):
            skill_packages.parse(archive(raw))
        with zipfile.ZipFile(io.BytesIO(archive(raw, "skills/fixture/SKILL.md"))) as package:
            with self.assertRaisesRegex(ValueError, "name"):
                plugin_adapters.discover_skills(package, {x.filename: x for x in package.infolist()})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "SKILL.md"
            path.write_text(raw, encoding="utf-8")
            self.assertEqual(skills._parse_front(str(path), "local-fixture")["name"], "local-fixture")

    def test_plugin_draft_does_not_silently_cut_text(self):
        base = {"template": "method", "key": "fixture", "name": "Fixture",
                "description": "Valid description", "instructions": "Full instructions"}
        for field, limit in [("description", 600), ("instructions", 8000)]:
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "超过|过长"):
                plugin_drafts.build({**base, field: "x" * limit + "Tail requirement"})

    def test_structural_and_utf16_limits_reject_before_materialization(self):
        headers = ["name: fixture\ndescription: " + "😀" * 513,
                   "name: fixture\ndescription: good\nmetadata: " + "[" * 33 + "x" + "]" * 33,
                   "name: fixture\ndescription: good\nmetadata: [" + ",".join(["x"] * 2050) + "]",
                   "name: fixture\ndescription: good\n# " + "x" * 65536,
                   "name: fixture\ndescription: good\nmetadata: !!binary YQ==",
                   "name: fixture\ndescription: good\nmetadata: {42: value}"]
        for header in headers:
            with self.subTest(header=header[:70]), self.assertRaises(ValueError):
                skill_packages.parse(archive(document(header)))

    def test_yaml12_plain_text_remains_strings_without_yaml11_coercion(self):
        for value in ["yes", "no", "off", "ON", "12:34:56", "2026-10-15", "0b1010", "+.NaN", "-.NaN"]:
            with self.subTest(value=value):
                parsed = skill_packages.parse(archive(document("name: fixture\ndescription: " + value)))
                self.assertEqual(parsed["description"], value)

    def test_explicit_invalid_core_types_are_rejected_as_validation_errors(self):
        for value in ["!!bool yes", "!!bool bananas", "!!float 1:2.3", "!!float 42", "!!int 12:34", "!!null anything"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                skill_packages.parse(archive(document("name: fixture\ndescription: good\nmetadata: " + value)))


if __name__ == "__main__":
    unittest.main()
