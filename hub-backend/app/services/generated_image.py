"""Validate a generated still image before publishing the original bytes."""
import sys
from io import BytesIO

from PIL import Image, UnidentifiedImageError

MAX_BYTES = 32 * 1024 * 1024


def validate_image(raw):
    if not raw or len(raw) > MAX_BYTES:
        raise ValueError("图片文件无效或超过 32MB")
    if not media_type(raw):
        raise ValueError("图片文件无效或不完整，仅支持 PNG、JPEG、WebP")
    try:
        with Image.open(BytesIO(raw), formats=["PNG", "JPEG", "WEBP"]) as picture:
            if picture.width * picture.height > 32_000_000 or getattr(picture, "n_frames", 1) != 1:
                raise ValueError("图片分辨率超过 3200 万像素或包含多帧，请调整图片模型输出参数")
            mime = Image.MIME[picture.format]
            picture.verify()
        # verify checks the container; load also detects incomplete pixel data.
        with Image.open(BytesIO(raw), formats=["PNG", "JPEG", "WEBP"]) as picture:
            picture.load()
        return mime
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError) as exc:
        raise ValueError("图片文件无效或不完整，仅支持 PNG、JPEG、WebP") from exc


def media_type(raw: bytes) -> str:
    if raw.startswith(b"\x89PNG\r\n\x1a\n") and raw.endswith(b"\x00\x00\x00\x00IEND\xaeB`\x82"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff") and raw.endswith(b"\xff\xd9"):
        return "image/jpeg"
    if len(raw) >= 20 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP" and \
            int.from_bytes(raw[4:8], "little") + 8 == len(raw):
        return "image/webp"
    return ""


if __name__ == "__main__":
    if sys.argv[1:] == ["--check"]:
        sys.exit(0)
    try:
        if len(sys.argv) == 2:
            with open(sys.argv[1], "rb") as source:
                raw = source.read(MAX_BYTES + 1)
        else:
            raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        print(validate_image(raw))
    except ValueError:
        sys.exit(2)
