"""Read-only structural inventory for DOCX and XLSX files."""
import argparse
import json
from pathlib import Path
import sys
from zipfile import ZipFile

WORD_HEADING_STYLES = {f"Heading {level}" for level in range(1, 10)}


def inspect_document(source):
    from docx import Document
    from docx.enum.style import WD_STYLE_TYPE

    document = Document(source)
    body = document.element.body
    if body is None:
        raise ValueError("Missing Word document body")
    heading_styles = set()
    for style in document.styles:
        if style.type != WD_STYLE_TYPE.PARAGRAPH:
            continue
        current = style
        visited = set()
        builtin_heading = False
        while current is not None and current.style_id not in visited:
            visited.add(current.style_id)
            levels = current.element.xpath("./w:pPr/w:outlineLvl/@w:val")
            if levels:
                if 0 <= int(levels[0]) < 9:
                    heading_styles.add(style.style_id)
                break
            if current.builtin and current.name in WORD_HEADING_STYLES:
                builtin_heading = True
            current = current.base_style
        else:
            # Some producers emit built-in heading styles without outlineLvl.
            if builtin_heading:
                heading_styles.add(style.style_id)

    default_style = document.styles.default(WD_STYLE_TYPE.PARAGRAPH)
    default_id = default_style.style_id if default_style is not None else None
    paragraphs = body.xpath(".//w:p")
    headings = 0
    for paragraph in paragraphs:
        levels = paragraph.xpath("./w:pPr/w:outlineLvl/@w:val")
        if levels:
            headings += 0 <= int(levels[0]) < 9
        else:
            styles = paragraph.xpath("./w:pPr/w:pStyle/@w:val")
            headings += (styles[0] if styles else default_id) in heading_styles
    return {"paragraphCount": len(paragraphs), "headingCount": headings,
            "tableCount": len(body.xpath(".//w:tbl")), "imageCount": len(body.xpath(".//pic:pic"))}


def inspect_sheet(sheet, package):
    from lxml import etree
    from openpyxl.utils.cell import coordinate_to_tuple, get_column_letter, range_boundaries

    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    first_row, first_col = sys.maxsize, sys.maxsize
    last_row = last_col = formulas = row_number = 0
    merges = []
    # ReadOnlyWorksheet omits merged ranges. Read its resolved OOXML part
    # directly, visiting only stored rows and cells even for very sparse sheets.
    with package.open(sheet._worksheet_path) as source:
        events = etree.iterparse(source, events=("end",), tag=(ns + "row", ns + "mergeCell"),
                                 resolve_entities=False, no_network=True)
        for _, element in events:
            if element.tag == ns + "row":
                row_number = int(element.get("r", row_number + 1))
                col = 0
                for cell in element.iterchildren(ns + "c"):
                    if cell.get("r"):
                        row, col = coordinate_to_tuple(cell.get("r"))
                    else:
                        row, col = row_number, col + 1
                    first_row, last_row = min(first_row, row), max(last_row, row)
                    first_col, last_col = min(first_col, col), max(last_col, col)
                    formulas += cell.find(ns + "f") is not None
            else:
                ref = element.attrib["ref"]
                left, top, right, bottom = range_boundaries(ref)
                first_row, last_row = min(first_row, top), max(last_row, bottom)
                first_col, last_col = min(first_col, left), max(last_col, right)
                merges.append(ref)
            element.clear()
            while element.getprevious() is not None:
                del element.getparent()[0]
        if events.root.tag != ns + "worksheet" or events.root.find(ns + "sheetData") is None:
            raise ValueError("Missing worksheet data: " + sheet.title)
    used = None
    if last_row:
        used = f"{get_column_letter(first_col)}{first_row}:{get_column_letter(last_col)}{last_row}"
    return {"name": sheet.title, "range": used, "formulaCount": formulas, "mergedRanges": merges}


def inspect_workbook(source):
    from openpyxl.reader.excel import ExcelReader
    from openpyxl.xml.constants import XLSX

    reader = ExcelReader(source, read_only=True, keep_links=False)
    try:
        reader.read()
        if reader.package.find(XLSX) is None:
            raise ValueError("File does not contain an XLSX workbook")
        # The ordinary workbook loader silently drops missing worksheet parts.
        declared = [sheet.name for sheet in reader.parser.sheets]
        if not declared or declared != reader.wb.sheetnames:
            raise ValueError("Workbook sheet inventory is missing or incomplete")
        return {"sheets": [inspect_sheet(sheet, reader.archive) for sheet in reader.wb.worksheets]}
    finally:
        reader.archive.close()


def inspect(path):
    path = Path(path)
    kind = path.suffix.lower().lstrip(".")
    if kind not in {"docx", "xlsx"}:
        raise ValueError("Expected a .docx or .xlsx file")
    with path.open("rb") as source, ZipFile(source) as package:
        entries = package.infolist()
        if len(entries) > 10000 or sum(entry.file_size for entry in entries) > 256 * 1024 * 1024:
            raise ValueError("Document exceeds the inspection limit")
        corrupt = package.testzip()
        if corrupt is not None:
            raise ValueError(f"Corrupt ZIP entry: {corrupt}")
        facts = inspect_document(source) if kind == "docx" else inspect_workbook(source)
    return {"format": kind, "rendered": False, **facts}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    args = parser.parse_args()
    try:
        report = inspect(args.file)
    except Exception as exc:
        parser.exit(1, f"Office inspection failed: {exc}\n")
    print(json.dumps(report, indent=2))
