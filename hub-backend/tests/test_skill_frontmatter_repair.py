"""Offline legacy package repair keeps sources immutable and validates outputs."""
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from app.services import skill_packages


def legacy_document(description="Evidence: preserve # logs", *, newline="\n", bom=False):
    text = newline.join(["---", "name: debug-radar", "description: " + description,
                         "---", "", "# 原始正文", "Do not change: body bytes.", ""])
    return (b"\xef\xbb\xbf" if bom else b"") + text.encode("utf-8")


def package(files, prefix=""):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as output:
        for name, content in files.items():
            output.writestr(prefix + name, content)
    return buffer.getvalue()


class SkillFrontmatterRepairTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def prepare(self, source):
        # Assert the new contract before importing so a missing tool is a useful RED.
        from app.services import skill_packages as packages
        self.assertTrue(hasattr(packages, "read_package_files"),
                        "safe archive reading must be reusable without parsing bad YAML")
        self.assertIsNotNone(importlib.util.find_spec("app.services.skill_frontmatter_repair"),
                             "offline immutable Skill repair is not implemented")
        from app.services.skill_frontmatter_repair import prepare
        return prepare(source)

    def source(self, raw=None, *, prefix=""):
        source = self.root / "original.skill"
        original = package({"SKILL.md": raw or legacy_document(),
                            "assets/raw.bin": bytes(range(256))}, prefix)
        source.write_bytes(original)
        return source, original

    def test_actual_legacy_package_changes_only_description_line_and_checksum(self):
        raw = legacy_document(newline="\r\n", bom=True)
        source, original = self.source(raw, prefix="export/debug-radar/")
        plan = self.prepare(source)
        self.assertEqual(plan.report()["status"], "repairable")
        self.assertNotEqual(plan.report()["oldChecksum"], plan.report()["newChecksum"])
        output = self.root / "debug-radar-fixed.skill"
        plan.write(output)
        parsed = skill_packages.parse(output.read_bytes())
        self.assertEqual(parsed["description"], "Evidence: preserve # logs")
        expected = raw.replace(b"description: Evidence: preserve # logs",
                               b'description: "Evidence: preserve # logs"')
        self.assertEqual(parsed["files"]["SKILL.md"], expected)
        self.assertEqual(parsed["files"]["assets/raw.bin"], bytes(range(256)))
        self.assertEqual(parsed["checksum"], plan.report()["newChecksum"])
        self.assertEqual(source.read_bytes(), original)

    def test_directory_diagnostic_makes_no_files_and_ignores_cache_marker(self):
        source = self.root / "debug-radar"
        source.mkdir()
        raw = legacy_document('Trace C:\\logs: keep "all" evidence')
        (source / "SKILL.md").write_bytes(raw)
        (source / ".ready").write_bytes(b"old-checksum")
        before = {file.name: file.read_bytes() for file in source.iterdir()}
        plan = self.prepare(source)
        self.assertEqual(plan.report()["changedFiles"], ["SKILL.md"])
        self.assertEqual({file.name: file.read_bytes() for file in source.iterdir()}, before)
        output = self.root / "fixed.skill"
        plan.write(output)
        parsed = skill_packages.parse(output.read_bytes())
        self.assertNotIn(".ready", parsed["files"])
        self.assertEqual(parsed["description"], 'Trace C:\\logs: keep "all" evidence')

    def test_valid_yaml_is_unchanged_including_legal_inline_comment(self):
        for description in ['Already valid', 'A # legal YAML comment',
                            '"Evidence: preserve logs"', '|\n  Evidence: preserve logs']:
            with self.subTest(description=description):
                source, original = self.source(legacy_document(description))
                plan = self.prepare(source)
                self.assertEqual(plan.report()["status"], "valid")
                self.assertEqual(plan.report()["oldChecksum"], plan.report()["newChecksum"])
                self.assertEqual(plan.report()["changedFiles"], [])
                with self.assertRaisesRegex(ValueError, "无需修复|already valid"):
                    plan.write(self.root / "unnecessary.skill")
                self.assertEqual(source.read_bytes(), original)

    def test_ambiguous_or_other_invalid_yaml_is_not_guessed(self):
        samples = [
            legacy_document().replace(b"name: debug-radar", b"name: debug-radar\nname: other"),
            legacy_document().replace(b"---\n\n#", b"  continuation text\n---\n\n#"),
            legacy_document().replace(b"name: debug-radar", b"name: debug-radar\nmetadata:\n  a: b"),
            legacy_document('[broken: value'), legacy_document('"broken: value'),
            legacy_document('plain\tvalue'), legacy_document('true'),
            legacy_document().replace(b"name: debug-radar", b"name: WRONG_NAME"),
            legacy_document().replace(b"name: debug-radar", b"name: debug-radar\nlicense: [broken"),
            legacy_document().replace(b"name: debug-radar", b"name: debug-radar\nmetadata: &x {a: b}\ncopy: *x"),
            legacy_document().replace(b"# \xe5\x8e\x9f", b"# \xff"),
        ]
        for raw in samples:
            with self.subTest(raw=raw):
                source, original = self.source(raw)
                with self.assertRaises(ValueError):
                    self.prepare(source)
                self.assertEqual(source.read_bytes(), original)

    def test_unsafe_zip_is_rejected_before_repair(self):
        for extra in ["../escape", "SKILL.MD", "folder/../../escape", "A/file", ".ready"]:
            with self.subTest(extra=extra):
                source = self.root / "unsafe.zip"
                files = {"SKILL.md": legacy_document(), extra: b"x"}
                if extra == "A/file":
                    files["a/other"] = b"y"
                source.write_bytes(package(files))
                with self.assertRaises(ValueError):
                    self.prepare(source)

    def test_description_with_control_character_is_not_misidentified_as_colon_only(self):
        for description in ['Evidence: keep \x00', 'Evidence: keep \t tabs', 'Evidence: keep \x7f']:
            with self.subTest(description=description):
                source, original = self.source(legacy_document(description))
                with self.assertRaises(ValueError):
                    self.prepare(source)
                self.assertEqual(source.read_bytes(), original)

    def test_archive_resource_limits_apply_before_repair(self):
        for raw in [b"x" * (skill_packages._MAX_PACKAGE + 1),
                    package({"SKILL.md": legacy_document(),
                             **{f"assets/{i}.txt": b"a" for i in range(300)}})]:
            with self.subTest(size=len(raw)):
                source = self.root / "large.skill"
                source.write_bytes(raw)
                with self.assertRaisesRegex(ValueError, "10MB|文件过多"):
                    self.prepare(source)

    def test_output_cannot_replace_source_existing_file_or_enter_source_tree(self):
        source, original = self.source()
        plan = self.prepare(source)
        occupied = self.root / "occupied.skill"
        occupied.write_bytes(b"keep")
        for destination in [source, occupied]:
            with self.subTest(destination=destination):
                with self.assertRaises((ValueError, FileExistsError)):
                    plan.write(destination)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(occupied.read_bytes(), b"keep")
        directory = self.root / "source"
        directory.mkdir()
        (directory / "SKILL.md").write_bytes(legacy_document())
        with self.assertRaisesRegex(ValueError, "源目录|source directory"):
            self.prepare(directory).write(directory / "nested.skill")
        self.assertFalse((directory / "nested.skill").exists())

    def test_cli_returns_actionable_rejection_without_creating_output(self):
        source, original = self.source(legacy_document('"bad: quote'))
        output = self.root / "rejected.skill"
        command = [sys.executable, str(Path(__file__).resolve().parents[1] / "repair_skill_package.py"),
                   str(source), "--output", str(output)]
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                                timeout=20, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stderr)["status"], "rejected")
        self.assertEqual(result.stdout, "")
        self.assertFalse(output.exists())
        self.assertEqual(source.read_bytes(), original)

    def test_existing_dangling_symlink_output_is_rejected(self):
        source, original = self.source()
        link = self.root / "existing-link.skill"
        target = self.root / "missing-target.skill"
        try:
            link.symlink_to(target)
        except OSError as exc:
            self.skipTest(f"This host cannot create a symlink: {exc}")
        with self.assertRaises((FileExistsError, ValueError)):
            self.prepare(source).write(link)
        self.assertTrue(link.is_symlink())
        self.assertFalse(target.exists())
        self.assertEqual(source.read_bytes(), original)

    def test_cli_defaults_to_read_only_and_explicit_output_is_strictly_valid(self):
        source, original = self.source()
        command = [sys.executable, str(Path(__file__).resolve().parents[1] / "repair_skill_package.py"),
                   str(source)]
        environment = {**os.environ, "PYTHONIOENCODING": "utf-8"}
        diagnostic = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                                    timeout=20, env=environment)
        self.assertEqual(diagnostic.returncode, 0, diagnostic.stderr)
        report = json.loads(diagnostic.stdout)
        self.assertEqual(report["status"], "repairable")
        self.assertEqual(list(self.root.iterdir()), [source])
        output = self.root / "fixed.skill"
        applied = subprocess.run(command + ["--output", str(output)], capture_output=True,
                                 text=True, encoding="utf-8", timeout=20, env=environment)
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertEqual(json.loads(applied.stdout)["output"], str(output.resolve()))
        self.assertEqual(skill_packages.parse(output.read_bytes())["checksum"], report["newChecksum"])
        self.assertEqual(source.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
