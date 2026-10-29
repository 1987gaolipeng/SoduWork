"""Exercise the shipped read-only presentation checker on real PPTX packages."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

from pptx import Presentation
from pptx.util import Inches

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("soduwork_presentation_check",
    ROOT / "skills/pptx/scripts/inspect_deck.py")
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class PresentationSkillTests(unittest.TestCase):
    def test_real_editable_slides_and_read_only_inventory(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-presentation-test-") as work:
            target = Path(work) / "deck.pptx"
            deck = Presentation()
            page = deck.slides.add_slide(deck.slide_layouts[6])
            page.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(1)).text = "Editable report"
            page.shapes.add_table(2, 2, Inches(1), Inches(3), Inches(5), Inches(2))
            page = deck.slides.add_slide(deck.slide_layouts[6])
            page.shapes.add_textbox(Inches(-1), Inches(1), Inches(2), Inches(1)).text = "Check bounds"
            deck.save(target)
            before = hashlib.sha256(target.read_bytes()).hexdigest()
            report = check.inspect(target)
            self.assertEqual(report["slideCount"], 2)
            self.assertEqual(report["slides"][0]["text"], ["Editable report"])
            self.assertEqual(report["slides"][0]["tables"], 1)
            self.assertEqual(report["slides"][0]["warnings"], [])
            self.assertEqual(report["slides"][1]["warnings"][0]["issue"], "outside-slide-bounds")
            self.assertFalse(report["rendered"])
            self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), before)
            # Editing a new candidate does not modify the original template.
            candidate = Presentation(target)
            candidate.slides[0].shapes[0].text_frame.paragraphs[0].runs[0].text = "Updated report"
            edited = Path(work) / "edited.pptx"
            candidate.save(edited)
            self.assertEqual(check.inspect(edited)["slides"][0]["text"], ["Updated report"])
            self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), before)

    def test_non_presentation_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-presentation-test-") as work:
            invalid = Path(work) / "invalid.pptx"
            invalid.write_bytes(b"not a presentation")
            with self.assertRaises(zipfile.BadZipFile):
                check.inspect(invalid)


if __name__ == "__main__":
    unittest.main()
