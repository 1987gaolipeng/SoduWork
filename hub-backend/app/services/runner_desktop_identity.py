"""Device-scoped embedded Runner IDs, preserving healthy legacy registrations.

The caller holds the installation's Runner lock. Never reset the legacy ID or
reuse another device's queue. Only an explicit identity conflict can migrate an
already enrolled scope; network/auth failures must not manufacture identities.
"""
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit

from . import durable_file


def select(root, hub, client_id, legacy_id, *, rejected_id=""):
    url = urlsplit(hub)
    scheme = {"ws": "http", "wss": "https"}.get(url.scheme, url.scheme)
    scope = hashlib.sha256((scheme + "://" + url.netloc.lower() + "|" + client_id).encode()).hexdigest()
    path = Path(root) / "desktop-runner-identities.json"
    try:
        identities = json.loads(durable_file.read_bytes(path))
        if not isinstance(identities, dict) or any(
                not isinstance(value, str) or not value or len(value) > 64
                for value in identities.values()):
            raise ValueError("本机执行机身份记录损坏，请检查本机存储")
    except FileNotFoundError:
        identities = {}
    current = identities.get(scope)
    scoped_id = "desktop-" + hashlib.sha256((legacy_id + "|" + scope).encode()).hexdigest()[:32]
    if rejected_id:
        if current != rejected_id or current == scoped_id:
            raise ValueError("本机执行机身份恢复后仍被拒绝，请检查设备登记")
        chosen = scoped_id
    else:
        chosen = current or (scoped_id if identities else legacy_id)
    if chosen != current:
        identities[scope] = chosen
        durable_file.write_bytes(path, json.dumps(identities, sort_keys=True).encode("utf-8"))
    return chosen
