"""Passive cover URLs; never fetched by the Hub."""
from urllib.parse import urlsplit


def normalize(value) -> str:
    if value is None or value == '':
        return ''
    if not isinstance(value, str) or len(value) > 2048 or any(c.isspace() or ord(c) < 32 for c in value):
        raise ValueError('封面地址必须是有效的 HTTP(S) 图片地址')
    try:
        url = urlsplit(value)
        if url.scheme not in {'http', 'https'} or not url.hostname or url.username or url.password:
            raise ValueError()
        _ = url.port
    except ValueError:
        raise ValueError('封面地址必须是有效的 HTTP(S) 图片地址') from None
    return value


def public(value) -> str:
    try:
        return normalize(value)
    except ValueError:
        return ''
