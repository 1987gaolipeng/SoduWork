"""Shared system TLS trust for Runner control connections on every platform."""


def websocket_options(url: str) -> dict:
    if not url.lower().startswith("wss://"):
        return {}
    from .runtime_tls import client_context

    return {"ssl": client_context()}
