"""Bounded, private disk outbox for the existing execution-session transport.

SQLite FULL commits precede transmission and local cursor advancement. The
native execution archive remains the source when capacity applies backpressure.
No packet in this store starts or retries an execution.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager

from .runner_admission_journal import _protect, _storage_root

CAPABILITY = "sessionAck1"
MAX_PACKET_BYTES = 512 * 1024
DEFAULT_MAX_BYTES = 256 * 1024 * 1024
DEFAULT_MAX_PACKETS = 4096


def snapshot_bytes(snapshot: dict) -> bytes:
    return json.dumps(snapshot, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def snapshot_digest(snapshot: dict) -> str:
    return hashlib.sha256(snapshot_bytes(snapshot)).hexdigest()


class OutboxFull(OSError):
    """Capacity pressure leaves both the archive and collection cursor intact."""


class Outbox:
    def __init__(self, root, identity: str, *, max_bytes=DEFAULT_MAX_BYTES,
                 max_packets=DEFAULT_MAX_PACKETS):
        self.root = _storage_root(root) / hashlib.sha256(identity.encode()).hexdigest()
        if self.root.is_symlink():
            raise OSError("Runner event directory must not be a symlink")
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if os.name != "nt":
            os.chmod(self.root, 0o700)
        self.path = self.root / "events.sqlite3"
        self.max_bytes, self.max_packets = max_bytes, max_packets
        self._lock = threading.RLock()
        with self._connect() as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS streams (
                    ref TEXT PRIMARY KEY, stream_id TEXT NOT NULL,
                    next_seq INTEGER NOT NULL, event_seq INTEGER NOT NULL,
                    state TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS packets (
                    id INTEGER PRIMARY KEY, ref TEXT NOT NULL,
                    delivery_seq INTEGER NOT NULL, digest TEXT NOT NULL,
                    payload BLOB NOT NULL, size INTEGER NOT NULL,
                    UNIQUE(ref, delivery_seq));
            """)
        if os.name != "nt":
            os.chmod(self.path, 0o600)
            descriptor = os.open(self.root, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)

    @contextmanager
    def _connect(self):
        with self._lock:
            if any(path.is_symlink() for path in (
                    self.path, self.root / "events.sqlite3-wal",
                    self.root / "events.sqlite3-shm")):
                raise OSError("Runner event database must not be a symlink")
            connection = sqlite3.connect(str(self.path), timeout=5)
            try:
                connection.execute("PRAGMA journal_mode=WAL")
                connection.execute("PRAGMA synchronous=FULL")
                connection.execute("PRAGMA wal_autocheckpoint=128")
                connection.execute("PRAGMA journal_size_limit=4194304")
                connection.execute("PRAGMA max_page_count=%d" % (
                    (self.max_bytes + 8 * 1024 * 1024) // 4096))
                with connection:
                    yield connection
            finally:
                connection.close()

    def marks(self) -> dict[str, tuple[int, str]]:
        with self._connect() as connection:
            return {ref: (seq, state) for ref, seq, state in connection.execute(
                "SELECT ref, event_seq, state FROM streams")}

    def at_capacity(self) -> bool:
        with self._connect() as connection:
            count, size = connection.execute(
                "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM packets").fetchone()
            return count >= self.max_packets or size >= self.max_bytes

    def append(self, snapshot: dict, mark: tuple) -> None:
        raw = snapshot_bytes(snapshot)
        if len(raw) > MAX_PACKET_BYTES:
            raise OutboxFull("Runner event packet exceeds the bounded frame size")
        ref, event_seq, state = mark
        if snapshot.get("ref") != ref:
            raise ValueError("Runner event cursor identity mismatch")
        payload = b"DPAPI\n" + _protect(raw) if os.name == "nt" else b"JSON\n" + raw
        try:
            with self._connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                count, size = connection.execute(
                    "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM packets").fetchone()
                if count >= self.max_packets or size + len(payload) > self.max_bytes:
                    raise OutboxFull("Runner event outbox is full; waiting for durable ACK")
                stream = connection.execute(
                    "SELECT stream_id, next_seq FROM streams WHERE ref=?", (ref,)).fetchone()
                stream_id, seq = stream if stream else (uuid.uuid4().hex, 1)
                connection.execute(
                    "INSERT INTO packets(ref,delivery_seq,digest,payload,size) VALUES(?,?,?,?,?)",
                    (ref, seq, hashlib.sha256(raw).hexdigest(), payload, len(payload)))
                connection.execute("""INSERT INTO streams VALUES(?,?,?,?,?)
                    ON CONFLICT(ref) DO UPDATE SET next_seq=excluded.next_seq,
                        event_seq=excluded.event_seq, state=excluded.state""",
                    (ref, stream_id, seq + 1, event_seq, state))
        except sqlite3.OperationalError as exc:
            if "full" in str(exc).lower():
                raise OutboxFull("Runner event storage is full") from exc
            raise

    def pending(self, limit=12, after_ref="") -> list[dict]:
        with self._connect() as connection:
            rows = connection.execute("""SELECT p.ref, s.stream_id, p.delivery_seq,
                    p.digest, p.payload FROM packets p JOIN streams s ON s.ref=p.ref
                WHERE NOT EXISTS (SELECT 1 FROM packets older
                    WHERE older.ref=p.ref AND older.delivery_seq<p.delivery_seq)
                ORDER BY CASE WHEN p.ref > ? THEN 0 ELSE 1 END, p.ref
                LIMIT ?""", (after_ref, limit)).fetchall()
        return [self._packet(row) for row in rows]

    def replay_pending(self, limit=12, after_id=0) -> list[tuple[int, dict]]:
        """Cycle through all retained packets for a Hub without durable ACKs.

        The cursor is process memory only. It never acknowledges a packet or
        alters the per-ref stop-and-wait query used by reliable delivery.
        """
        with self._connect() as connection:
            rows = connection.execute("""SELECT p.id, p.ref, s.stream_id,
                    p.delivery_seq, p.digest, p.payload
                FROM packets p JOIN streams s ON s.ref=p.ref
                ORDER BY CASE WHEN p.id > ? THEN 0 ELSE 1 END, p.id
                LIMIT ?""", (after_id, limit)).fetchall()
        return [(row[0], self._packet(row[1:])) for row in rows]

    @staticmethod
    def _packet(row) -> dict:
        ref, stream_id, seq, digest, payload = row
        if payload.startswith(b"DPAPI\n") and os.name == "nt":
            raw = _protect(payload[6:], decrypt=True)
        elif payload.startswith(b"JSON\n") and os.name != "nt":
            raw = payload[5:]
        else:
            raise OSError("Runner event protection is not available for this account")
        if hashlib.sha256(raw).hexdigest() != digest:
            raise OSError("Runner event packet checksum mismatch")
        return {"ref": ref, "streamId": stream_id, "deliverySeq": seq,
                "digest": digest, "snapshot": json.loads(raw)}

    def acknowledge(self, message: dict) -> bool:
        """Delete only the exact packet the authenticated Hub committed."""
        with self._connect() as connection:
            result = connection.execute("""DELETE FROM packets WHERE ref=?
                AND delivery_seq=? AND digest=? AND EXISTS (SELECT 1 FROM streams
                    WHERE ref=packets.ref AND stream_id=?)""", (
                str(message.get("ref") or ""), message.get("deliverySeq"),
                str(message.get("digest") or ""), str(message.get("streamId") or "")))
            return result.rowcount == 1
