"""Small raster thumbnails; never send original image payloads to list views."""
from io import BytesIO
from PIL import Image, ImageOps
from .library_read_cache import ReadWorkCache
from .library_storage import LibraryStorageError

MAX_SOURCE = 16 * 1024 * 1024
MAX_PIXELS = 16_000_000
cache = ReadWorkCache(concurrency=2, pending=16, entries=256, max_bytes=8 * 1024 * 1024)


def render(open_stream):
    stream = open_stream()
    try:
        # Bound compressed input as well as decoded pixels. Unknown formats
        # retain the ordinary image icon; explicit original downloads still work.
        content = stream.read(MAX_SOURCE + 1)
        if len(content) > MAX_SOURCE:
            raise ValueError("source too large")
        with Image.open(BytesIO(content)) as image:
            if image.width * image.height > MAX_PIXELS:
                raise ValueError("image dimensions too large")
            image.seek(0)
            image.thumbnail((256, 256))
            image = ImageOps.exif_transpose(image).convert("RGBA")
            output = BytesIO()
            image.save(output, format="PNG")
            data = output.getvalue()
            if len(data) > 512 * 1024:
                raise ValueError("thumbnail too large")
            return data
    except (ValueError, OSError, Image.DecompressionBombError) as exc:
        raise LibraryStorageError("LIBRARY_THUMBNAIL_UNAVAILABLE", "此图片暂不支持缩略图，可打开原文件查看", False) from exc
    finally:
        try:
            stream.close()
        finally:
            release = getattr(stream, "release_conn", None)
            if release:
                release()
