"""Integer fields shared by JSON APIs with legacy decimal-string clients."""
import re

from fastapi import HTTPException


INT32_MIN = -(2**31)
INT32_MAX = 2**31 - 1
_DECIMAL = re.compile(r"[+-]?[0-9]+")


def parse_integer(
    value: object,
    *,
    field: str,
    default: int | None = None,
    minimum: int = INT32_MIN,
    maximum: int = INT32_MAX,
) -> int:
    """Reject lossy coercions before persistence on SQLite or PostgreSQL.

    Older clients send decimal strings and optional fields as null/empty text.
    Callers explicitly opt into the latter by supplying a default. Booleans,
    floats (including nonfinite values), and containers are never integers.
    Bound decimal text before int() to avoid Python's digit limit or overflow.
    """
    error = HTTPException(
        status_code=400,
        detail=f"{field} must be an integer between {minimum} and {maximum}",
    )
    if value is None or (isinstance(value, str) and value == ""):
        if default is None:
            raise error
        value = default
    if type(value) is int:
        parsed = value
    elif isinstance(value, str):
        text = value.strip()
        if not _DECIMAL.fullmatch(text):
            raise error
        negative = text.startswith("-")
        digits = text.lstrip("+-").lstrip("0") or "0"
        if len(digits) > max(len(str(abs(minimum))), len(str(abs(maximum)))):
            raise error
        parsed = int(digits) * (-1 if negative else 1)
    else:
        raise error
    if not minimum <= parsed <= maximum:
        raise error
    return parsed
