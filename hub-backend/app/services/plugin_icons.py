"""Bounded, self-contained plugin artwork. URLs and active image formats are not allowed."""
import base64
import binascii
import re
import struct

PREFIX = 'data:image/png;base64,'
MAX_BYTES = 96 * 1024


def normalize(value) -> str:
    if value is None or value == '':
        return ''
    if (not isinstance(value, str) or len(value) > len(PREFIX) + MAX_BYTES * 4 // 3
            or not value.startswith(PREFIX)):
        raise ValueError('插件图标需为不超过 96 KB 的 PNG 图片，请重新上传图标')
    encoded = value[len(PREFIX):]
    try:
        if not re.fullmatch(r'(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?', encoded):
            raise ValueError('invalid base64')
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError('插件图标编码无效，请重新上传图标') from None
    if (len(data) < 57 or len(data) > MAX_BYTES
            or not data.startswith(b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR')
            or not data.endswith(b'\x00\x00\x00\x00IEND\xaeB`\x82')
            or not all(1 <= size <= 256 for size in struct.unpack('>II', data[16:24]))):
        raise ValueError('插件图标格式无效或尺寸超过 256 × 256，请重新上传图标')
    return value


def public(value) -> str:
    """An invalid legacy icon must not break the entire catalog."""
    try:
        return normalize(value)
    except ValueError:
        return ''
