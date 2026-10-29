"""Bounded read-only file previews, separate from lossy editor round trips."""
import codecs
from html.parser import HTMLParser
from pathlib import PurePosixPath
import re

from fastapi import HTTPException

from . import library_formats

MAX_BYTES = 16 * 1024 * 1024
MAX_CHARACTERS = 2 * 1024 * 1024
_TEXT_EXTENSIONS = set((
    ".txt .text .log .csv .tsv .md .markdown .mdown .html .htm .xhtml "
    ".json .jsonl .ndjson .xml .yaml .yml .toml .ini .cfg .conf .config .env "
    ".js .mjs .cjs .jsx .ts .tsx .css .scss .less .sass .vue .svelte "
    ".py .pyi .ipynb .java .kt .kts .go .rs .c .h .cpp .hpp .cc .cs "
    ".swift .m .mm .rb .php .pl .r .sql .sh .bash .zsh .bat .cmd .ps1 "
    ".psm1 .psd1 .properties .gradle .dockerfile .gitignore .gitattributes "
    ".editorconfig .lock .diff .patch .tex .rst .asc .vbs .vb .dart .lua"
).split())
_BINARY_EXTENSIONS = set((
    ".doc .docx .xls .xlsx .ppt .pptx .rtf .odt .ods .odp .pdf .png .jpg .jpeg .gif .webp "
    ".bmp .ico .avif .heic .tif .tiff .zip .gz .tar .7z .rar .exe .dll "
    ".bin .dmg .msi .mp3 .wav .ogg .mp4 .mov .webm .sqlite .db"
).split())
_UNSUPPORTED = "此格式暂不支持内容预览，请使用系统应用打开或下载文件"
_CHARSETS = {"gbk": "gb18030", "gb2312": "gb18030", "gb18030": "gb18030",
             "utf-8": "utf-8", "utf-16le": "utf-16-le", "utf-16be": "utf-16-be",
             "windows-1252": "cp1252", "iso-8859-1": "latin-1"}


def _declared_charset(value):
    match = re.search(r"charset\s*=\s*[\"']?([\w-]+)", str(value), re.I)
    return match.group(1) if match else None


class _HtmlCharsetParser(HTMLParser):
    """Read declarations from a bounded ASCII-compatible HTML prefix only."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.encoding = None
        self.raw_text = None
        self.in_body = False

    def handle_starttag(self, tag, attrs):
        if self.encoding or self.in_body or self.raw_text:
            return
        if tag == "body":
            self.in_body = True
        elif tag in {"title", "textarea"}:
            self.raw_text = tag
        elif tag == "meta":
            attrs = dict(attrs)
            name = attrs.get("charset")
            if not name and str(attrs.get("http-equiv") or "").strip().lower() == "content-type":
                name = _declared_charset(attrs.get("content"))
            self.encoding = _CHARSETS.get(str(name or "").strip().lower().replace("_", "-"))

    def handle_endtag(self, tag):
        if tag == self.raw_text:
            self.raw_text = None


def _html_charset(data):
    parser = _HtmlCharsetParser()
    try:
        # Latin-1 preserves ASCII declaration bytes without guessing the text
        # encoding. It is never used to decode the returned document content.
        parser.feed(data[:4096].decode("latin-1"))
    except (AssertionError, ValueError):
        return None
    return parser.encoding


def preview_kind(filename, content_type=""):
    """Classify by file type without broadening the online editor allowlist."""
    extension = PurePosixPath(filename or "").suffix.lower()
    mime = str(content_type or "").split(";", 1)[0].strip().lower()
    if extension in _BINARY_EXTENSIONS:
        raise ValueError(_UNSUPPORTED)
    if extension in {".md", ".markdown", ".mdown"} or mime == "text/markdown":
        return "markdown"
    if extension in {".html", ".htm", ".xhtml"} or mime in {"text/html", "application/xhtml+xml"}:
        return "html"
    is_text = (extension in _TEXT_EXTENSIONS or not extension or mime.startswith("text/")
               or mime in {"application/json", "application/xml", "application/javascript", "application/x-yaml"}
               or mime.endswith(("+json", "+xml")))
    if not is_text:
        raise ValueError(_UNSUPPORTED)
    return "text" if extension in {"", ".txt", ".text", ".log", ".csv", ".tsv"} else "code"


def _decode_text(data, content_type, *, html=False):
    # A BOM is authoritative; try Unicode before legacy Chinese Windows text.
    # Strict decoding and control-character rejection prevent binary gibberish.
    encodings = ["utf-8", "gb18030"]
    for marker, encoding in (
        (codecs.BOM_UTF32_LE, "utf-32"), (codecs.BOM_UTF32_BE, "utf-32"),
        (codecs.BOM_UTF16_LE, "utf-16"), (codecs.BOM_UTF16_BE, "utf-16"),
        (codecs.BOM_UTF8, "utf-8-sig"),
    ):
        if data.startswith(marker):
            encodings = [encoding]
            break
    else:
        declared = _declared_charset(content_type)
        if declared:
            name = declared.lower().replace("_", "-")
            if name in _CHARSETS:
                encodings = [_CHARSETS[name]]
        elif html:
            encoding = _html_charset(data)
            if encoding:
                encodings = [encoding]
    for encoding in encodings:
        try:
            text = data.decode(encoding)
        except UnicodeError:
            continue
        if re.search(r"[\x00-\x08\x0b\x0e-\x1f\x7f-\x9f]", text):
            raise ValueError("文件包含二进制内容，无法作为文本预览")
        return text, encoding
    raise ValueError("无法识别文件的文本编码，请使用系统应用打开")


def read(filename, content_type, data):
    kind = preview_kind(filename, content_type)
    metadata = {"kind": kind, "truncated": False}
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "文件超过 16MB 内容预览限制，请使用系统应用打开")
    html = PurePosixPath(filename or "").suffix.lower() in {".html", ".htm", ".xhtml"}
    text, metadata["encoding"] = _decode_text(data, content_type, html=html)
    if len(text) > MAX_CHARACTERS:
        text = text[:MAX_CHARACTERS]
        metadata.update(truncated=True, notice="内容较长，仅显示前 200 万字符；完整内容请下载或使用系统应用打开")
    return {"content": text, "preview": metadata}


async def read_item(row, storage_call, backend, preview=False):
    """Share integrity checks with downloads before extracting preview content."""
    import asyncio
    if int(row.size or 0) > MAX_BYTES:
        raise HTTPException(413, "文件超过 16MB 内容预览限制，请使用系统应用打开")
    if isinstance((row.extra or {}).get("soduWorkDelivery"), dict):
        from . import delivery_collections
        data = await delivery_collections.read_payload(row)
    else:
        try:
            data = await asyncio.to_thread(storage_call, "read_bytes", row.storage_key, backend=backend)
        except ValueError as exc:
            raise HTTPException(413, "文件超过内容预览限制，请使用系统应用打开") from exc
    if preview:
        return await asyncio.to_thread(read, row.filename, row.content_type, data)
    read_kind, _ = library_formats.editor_format(row.kind, row.filename, row.content_type)
    return {"content": await asyncio.to_thread(library_formats.read, read_kind, data)}
