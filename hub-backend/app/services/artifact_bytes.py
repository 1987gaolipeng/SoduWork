"""Bound the amount of data a Hub or Runner reads for one output."""
import os
from io import BytesIO

MAX_BYTES = 512 * 1024 * 1024


class ArtifactTooLarge(RuntimeError):
    def __init__(self, limit):
        super().__init__(f"Output exceeds the {limit} byte delivery limit")


def read(stream, limit=None):
    limit = MAX_BYTES if limit is None else min(MAX_BYTES, limit)
    if os.fstat(stream.fileno()).st_size > limit:
        raise ArtifactTooLarge(limit)
    out = BytesIO()
    while chunk := stream.read(min(1024 * 1024, limit - out.tell() + 1)):
        if out.tell() + len(chunk) > limit:
            raise ArtifactTooLarge(limit)
        out.write(chunk)
    return out.getvalue()
