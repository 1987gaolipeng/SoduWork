"""Read-only structural inventory for a presentation. No rendering claims."""
import argparse
import json
from pathlib import Path
import zipfile


def inspect(filename):
    from pptx import Presentation

    path = Path(filename).resolve(strict=True)
    with zipfile.ZipFile(path) as package:
        entries = package.infolist()
        if len(entries) > 10000 or sum(row.file_size for row in entries) > 256 * 1024 * 1024:
            raise ValueError("Presentation exceeds the inspection limit")
        if package.testzip():
            raise ValueError("Presentation contains a corrupt ZIP entry")
    deck = Presentation(str(path))
    pages = []
    for number, slide in enumerate(deck.slides, 1):
        texts, warnings = [], []
        tables = charts = 0
        for shape in slide.shapes:
            if shape.has_text_frame:
                texts.append(shape.text)
            tables += int(shape.has_table)
            charts += int(shape.has_chart)
            if (shape.left < 0 or shape.top < 0 or shape.left + shape.width > deck.slide_width
                    or shape.top + shape.height > deck.slide_height):
                warnings.append({"shape": shape.name, "issue": "outside-slide-bounds"})
        pages.append({"page": number, "text": texts, "tables": tables, "charts": charts,
                      "shapes": len(slide.shapes), "warnings": warnings})
    return {"file": str(path), "slideCount": len(pages), "rendered": False,
            "widthEmu": deck.slide_width, "heightEmu": deck.slide_height, "slides": pages}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    args = parser.parse_args()
    print(json.dumps(inspect(args.file), ensure_ascii=False, indent=2))
