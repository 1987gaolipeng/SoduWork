"""Connector protocol for converting external items to Envelope records through shared aggregation.
Implement incremental pull(config, cursor) and native parse_webhook(headers, body) as supported
by the platform.
"""
from typing import Protocol, runtime_checkable


@runtime_checkable
class Connector(Protocol):
    type: str

    def pull(self, config: dict, cursor: dict) -> tuple[list[dict], dict]:
        """Return envelopes and the updated cursor for the supplied configuration and cursor."""
        ...

    def parse_webhook(self, headers: dict, body: bytes) -> list[dict]:
        """Parse a webhook payload into envelopes."""
        ...
