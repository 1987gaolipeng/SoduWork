"""Keep authentication material out of process logs.

Uvicorn includes the full WebSocket path in its connection messages, and the
access log records every HTTP request line with its query string.  Some of our
browser-compatible endpoints authenticate with query parameters -- WebSocket
handshakes, and the attachment download whose short-lived ``ticket`` *is* the
whole authorization boundary (see api/attachments.py).  Every such parameter
name has to appear in _QUERY_SECRET below, or the credential lands in the log
verbatim and can be replayed until it expires.
"""
from __future__ import annotations

import logging
import re
from collections.abc import Mapping

from httpx import URL


_QUERY_SECRET = re.compile(
    r"(?i)([?&](?:secret|token|ticket|key|api[_-]?key|access[_-]?token|"
    r"refresh[_-]?token|password|passwd|client[_-]?secret|app[_-]?secret|"
    r"runner[_-]?key|code|state|nonce|id[_-]?token|corpsecret)=)"
    r"([^&\s\"'<>]+)"
)
_AUTH_SCHEME_SECRET = re.compile(
    r"(?i)(authorization\s*[:=]\s*(?:bearer|basic|device|bot)\s+)"
    r"([^\s,;\"'<>]+)"
)
_AUTH_PLAIN_SECRET = re.compile(
    r"(?i)(authorization\s*[:=]\s*)"
    r"(?!(?:bearer|basic|device|bot)\s+|<redacted>)([^\s,;\"'<>]+)"
)
_HEADER_SECRET = re.compile(
    r"(?i)((?:x-soduwork-secret|x-telegram-bot-api-secret-token|x-acs-dingtalk-access-token)\s*[:=]\s*)([^\s,;\"'<>]+)"
)
_BOT_PATH_SECRET = re.compile(r"(?i)(api\.telegram\.org/bot)[0-9]+:[A-Za-z0-9_-]+")
_SECRET_FIELDS = (r"secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|"
                  r"id[_-]?token|runner[_-]?key|client[_-]?secret|app[_-]?secret|"
                  r"password|passwd|authorization|cookie|set-cookie|x-soduwork-secret|"
                  r"bot_token|webhook_secret|verification_token|encrypt_key|encoding_aes_key|signing_secret|"
                  r"x-telegram-bot-api-secret-token|x-acs-dingtalk-access-token")
_STRUCTURED_SECRET = re.compile(r"(?i)(?:" + _SECRET_FIELDS + r")")
_JSON_SECRET = re.compile(
    r"(?i)([\"'](?:" + _SECRET_FIELDS + r")"
    r"[\"']\s*:\s*[\"'])([^\"']*)([\"'])"
)


def redact_log_text(value: str) -> str:
    """Redact known credential shapes while preserving useful request context."""
    text = _QUERY_SECRET.sub(r"\1<redacted>", value)
    text = _AUTH_SCHEME_SECRET.sub(r"\1<redacted>", text)
    text = _AUTH_PLAIN_SECRET.sub(r"\1<redacted>", text)
    text = _HEADER_SECRET.sub(r"\1<redacted>", text)
    text = _BOT_PATH_SECRET.sub(r"\1<redacted>", text)
    return _JSON_SECRET.sub(r"\1<redacted>\3", text)


def _redact_value(value):
    if isinstance(value, URL):
        return redact_log_text(str(value))
    if isinstance(value, str):
        return redact_log_text(value)
    if isinstance(value, tuple):
        return tuple(_redact_value(item) for item in value)
    if isinstance(value, list):
        return [_redact_value(item) for item in value]
    if isinstance(value, Mapping):
        # Redact by field name before recursively scanning values that may lack recognizable secret prefixes.
        return {key: "<redacted>" if isinstance(key, str) and _STRUCTURED_SECRET.fullmatch(key)
                else _redact_value(item) for key, item in value.items()}
    return value


class SensitiveLogFilter(logging.Filter):
    """Scrub both a log format string and its deferred formatting arguments."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = _redact_value(record.msg)
        record.args = _redact_value(record.args)
        return True


def _attach(target) -> None:
    if not any(isinstance(item, SensitiveLogFilter) for item in target.filters):
        target.addFilter(SensitiveLogFilter())


def install_log_redaction() -> None:
    """Install idempotently on Uvicorn loggers and their current handlers."""
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "httpx", "httpcore"):
        logger = logging.getLogger(name)
        _attach(logger)
        for handler in logger.handlers:
            _attach(handler)
