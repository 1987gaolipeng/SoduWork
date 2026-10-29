"""Encrypted, bounded inter-Hub transport.

Durable business facts remain in PostgreSQL. Each process incarnation owns an
inbox stream: reconnecting Redis readers resume their cursor; commands are never
automatically retried after an ambiguous send. Runner dispatch IDs and the DB
outbox provide business idempotency, not an "exactly once" transport promise.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import logging
import os
import re
import time
import uuid

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from ..config import get_settings

log = logging.getLogger("uvicorn.error")
_MAX_PACKET = 16 * 1024 * 1024
_MAX_INBOX = 2048
_MAX_INBOX_BYTES = 64 * 1024 * 1024
_COMPARE_EXPIRE = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
"""
_COMPARE_DELETE = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""
_ENQUEUE = """
local bytes = tonumber(redis.call('GET', KEYS[2]) or '0')
if redis.call('XLEN', KEYS[1]) >= tonumber(ARGV[3])
   or bytes + string.len(ARGV[1]) > tonumber(ARGV[4]) then return false end
local id = redis.call('XADD', KEYS[1], '*', 'packet', ARGV[1])
redis.call('INCRBY', KEYS[2], string.len(ARGV[1]))
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return id
"""


_ACK = """
if redis.call('XDEL', KEYS[1], ARGV[1]) > 0 then
  local bytes = tonumber(redis.call('GET', KEYS[2]) or '0')
  redis.call('SET', KEYS[2], math.max(0, bytes - tonumber(ARGV[2])), 'EX', 120)
end
return 1
"""


class ClusterUnavailable(RuntimeError):
    pass


class RunnerOwnerChanged(ClusterUnavailable):
    pass


class PacketCodec:
    def __init__(self, secret: str, namespace: str):
        self.cipher = AESGCM(hashlib.sha256(
            ("soduwork-cluster-v1:" + secret).encode()).digest())
        self.aad = namespace.encode()

    def encode(self, value) -> bytes:
        paths = []
        def pack(item, path):
            if isinstance(item, bytes):
                paths.append(path)
                return base64.b64encode(item).decode("ascii")
            if isinstance(item, dict):
                return {key: pack(child, path + [key]) for key, child in item.items()}
            if isinstance(item, (list, tuple)):
                return [pack(child, path + [index]) for index, child in enumerate(item)]
            return item
        raw = json.dumps({"v": 1, "payload": pack(value, []), "binaryPaths": paths},
                         separators=(",", ":")).encode()
        if len(raw) > _MAX_PACKET:
            raise ValueError("Cluster packet exceeds 16 MiB")
        nonce = os.urandom(12)
        return nonce + self.cipher.encrypt(nonce, raw, self.aad)

    def decode(self, raw: bytes):
        if len(raw) > _MAX_PACKET + 28:
            raise ValueError("Cluster packet exceeds 16 MiB")
        wire = json.loads(self.cipher.decrypt(raw[:12], raw[12:], self.aad))
        if wire.get("v") != 1:
            raise ValueError("Unsupported cluster protocol version")
        value = wire["payload"]
        for path in wire["binaryPaths"]:
            if not path:
                value = base64.b64decode(value, validate=True)
                continue
            parent = value
            for key in path[:-1]:
                parent = parent[key]
            parent[path[-1]] = base64.b64decode(parent[path[-1]], validate=True)
        return value


class ClusterBus:
    def __init__(self, settings=None):
        self.settings = settings or get_settings()
        self.enabled = bool(self.settings.cluster_redis_url)
        self.node = str(uuid.uuid4())
        self.prefix = self.settings.cluster_namespace
        self.redis = None
        self.codec = PacketCodec(self.settings.auth_secret, self.prefix)
        self.peers = {}
        self.last_refresh = 0.0
        self._jobs = set()
        self._handlers = set()
        self._pending = {}
        self._cursor = "0-0"
        self._refresh_lock = asyncio.Lock()
        self.snapshot = lambda: {}
        self.before_refresh = None
        self.on_snapshot = lambda _: None
        self.on_event = None
        self.on_request = None
        self.on_failure = None
        self.stopping = False
        self.reader_ok = True
        self.received = 0
        self.sent = 0

    def key(self, kind: str, identity: str = ""):
        return f"{self.prefix}:{kind}:{identity}"

    @property
    def healthy(self):
        return not self.enabled or (
            not self.stopping and self.redis is not None
            and time.monotonic() - self.last_refresh < self.settings.cluster_lease_seconds / 2
            and self.reader_ok
            and bool(self._jobs) and all(not task.done() for task in self._jobs))

    def validate(self):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,48}", self.prefix):
            raise ValueError("CLUSTER_NAMESPACE must be a short alphanumeric deployment identifier")
        if self.settings.is_dev:
            raise ValueError("Multi-instance mode requires PostgreSQL, not SQLite")
        if self.settings.db_migration_mode != "check":
            raise ValueError("Run migrations once before replicas; set DB_MIGRATION_MODE=check")
        if not self.settings.cluster_shared_files:
            raise ValueError("Mount shared uploads/downloads/plugin/repository volumes and set CLUSTER_SHARED_FILES=true")
        if self.settings.db_pool_size < 4:
            raise ValueError("Cluster mode reserves a supervisor connection; DB_POOL_SIZE must be at least 4")
        if self.settings.cluster_refresh_seconds * 3 >= self.settings.cluster_lease_seconds:
            raise ValueError("Cluster refresh must be less than one third of the presence lease")

    async def start(self):
        if not self.enabled:
            return
        self.validate()
        self.stopping = False
        from redis.asyncio import Redis, BlockingConnectionPool
        pool = BlockingConnectionPool.from_url(
            self.settings.cluster_redis_url, socket_connect_timeout=3,
            socket_timeout=5, health_check_interval=15,
            max_connections=32, timeout=3)
        self.redis = Redis(connection_pool=pool)
        try:
            await self.redis.ping()
            # Establish the inbox before advertising this process to peers.
            await self.redis.xadd(self.key("inbox", self.node), {"packet": self.codec.encode(
                {"type": "noop", "deadline": time.time() + 10})})
            await self.redis.expire(self.key("inbox", self.node), 120)
            self._jobs.add(asyncio.create_task(self._read_loop(), name="cluster-inbox"))
            await self.refresh()
            self._jobs.add(asyncio.create_task(self._refresh_loop(), name="cluster-presence"))
        except BaseException:
            await self.stop()
            raise

    async def stop(self):
        self.stopping = True
        for future in self._pending.values():
            if not future.done():
                future.set_exception(ClusterUnavailable("Hub transport stopped"))
        jobs = list(self._jobs | self._handlers)
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
        self._jobs.clear()
        if self.redis:
            with contextlib.suppress(Exception):
                await self.redis.zrem(self.key("nodes"), self.node)
                await self.redis.delete(self.key("state", self.node), self.key("inbox", self.node),
                                        self.key("bytes", self.node))
            await self.redis.aclose(close_connection_pool=True)
            self.redis = None

    async def refresh(self):
        async with self._refresh_lock:
            await self._refresh_state()

    async def _refresh_state(self):
        now = time.time()
        ttl = self.settings.cluster_lease_seconds
        if self.before_refresh:
            await self.before_refresh()
        state = {"node": self.node, "label": self.settings.hub_node_id,
                 "at": now, **self.snapshot()}
        pipe = self.redis.pipeline()
        pipe.set(self.key("state", self.node), self.codec.encode(state), ex=ttl)
        pipe.zadd(self.key("nodes"), {self.node: now})
        pipe.zremrangebyscore(self.key("nodes"), "-inf", now - ttl)
        pipe.expire(self.key("nodes"), ttl * 2)
        await pipe.execute()
        nodes = await self.redis.zrangebyscore(self.key("nodes"), now - ttl, "+inf")
        if len(nodes) > 64:
            raise ClusterUnavailable("Cluster exceeds the supported 64 process limit")
        raw = await self.redis.mget([self.key("state", node.decode()) for node in nodes]) if nodes else []
        self.peers = {item["node"]: item for blob in raw if blob
                      for item in [self.codec.decode(blob)]}
        import inspect
        refreshed = self.on_snapshot(self.peers)
        if inspect.isawaitable(refreshed):
            await refreshed
        self.last_refresh = time.monotonic()

    async def _refresh_loop(self):
        failed = False
        while True:
            await asyncio.sleep(self.settings.cluster_refresh_seconds)
            try:
                await self.refresh()
                failed = False
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.last_refresh = 0
                if not failed:
                    log.error("Cluster presence unavailable: %s", type(exc).__name__)
                    if self.on_failure:
                        await self.on_failure()
                failed = True

    async def send(self, node: str, packet: dict, ttl: int = 120):
        if not self.redis or self.stopping:
            raise ClusterUnavailable("Cluster is unavailable")
        envelope = {**packet, "source": self.node,
                    "deadline": packet.get("deadline", time.time() + ttl)}
        result = await self.redis.eval(_ENQUEUE, 2, self.key("inbox", node),
                                       self.key("bytes", node), self.codec.encode(envelope),
                                       ttl, _MAX_INBOX, _MAX_INBOX_BYTES)
        if not result:
            raise ClusterUnavailable("Destination inbox is full")
        self.sent += 1

    async def broadcast(self, event: dict, *, strict: bool = False):
        # Discover recipients at publication time, including a just-started Hub.
        nodes = await self.redis.zrangebyscore(
            self.key("nodes"), time.time() - self.settings.cluster_lease_seconds, "+inf")
        targets = [node.decode() for node in nodes if node.decode() != self.node]
        if not targets:
            return
        # A full or disconnected node inbox must not fail the entire fan-out or business action.
        # Broadcast best-effort, record failures per node, and let later state synchronization converge.
        results = await asyncio.gather(
            *(self.send(node, {"type": "event", "event": event}) for node in targets),
            return_exceptions=True)
        for node, result in zip(targets, results):
            if isinstance(result, BaseException):
                log.warning("Cluster broadcast to %s failed: %s",
                            node, type(result).__name__)
        if strict and any(isinstance(result, BaseException) for result in results):
            raise ClusterUnavailable("Notification could not reach every Hub inbox")

    async def request(self, node: str, method: str, data: dict, timeout: float = 60):
        if not self.healthy:
            raise ClusterUnavailable("Cluster is not ready")
        if len(self._pending) >= self.settings.cluster_max_inflight:
            raise ClusterUnavailable("Too many in-flight cluster requests")
        rid = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self._pending[rid] = future
        try:
            await self.send(node, {"type": "request", "id": rid, "method": method,
                                  "data": data, "deadline": time.time() + timeout},
                            ttl=max(120, int(timeout) + 30))
            return await asyncio.wait_for(future, timeout)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise ClusterUnavailable(type(exc).__name__) from None
        finally:
            self._pending.pop(rid, None)

    async def _answer(self, packet):
        try:
            remaining = packet["deadline"] - time.time()
            if remaining <= 0:
                return
            result = await asyncio.wait_for(
                self.on_request(packet["method"], packet["data"], packet["source"]),
                timeout=remaining)
        except asyncio.CancelledError:
            raise
        except RunnerOwnerChanged:
            result = {"ok": False, "uncertain": False, "code": "RUNNER_OWNER_CHANGED"}
        except Exception as exc:
            result = {"ok": False, "uncertain": True,
                      "code": "CLUSTER_REQUEST_FAILED", "error": type(exc).__name__}
        with contextlib.suppress(Exception):
            await self.send(packet["source"], {"type": "reply", "id": packet["id"], "data": result})

    async def _consume(self, packet):
        kind = packet.get("type")
        if packet.get("deadline", 0) < time.time():
            return
        if kind == "reply":
            future = self._pending.get(packet.get("id"))
            if future and not future.done():
                future.set_result(packet.get("data"))
        elif kind == "event" and self.on_event:
            await self.on_event(packet["event"])
        elif kind == "request" and self.on_request:
            if len(self._handlers) >= self.settings.cluster_max_inflight:
                await self.send(packet["source"], {"type": "reply", "id": packet["id"],
                    "data": {"ok": False, "uncertain": False, "code": "CLUSTER_BUSY"}})
                return
            task = asyncio.create_task(self._answer(packet))
            self._handlers.add(task)
            task.add_done_callback(self._handlers.discard)

    async def _read_loop(self):
        while True:
            try:
                chunks = await self.redis.xread(
                    {self.key("inbox", self.node): self._cursor}, count=32, block=1000)
                self.reader_ok = True
                for _, entries in chunks:
                    for sequence, fields in entries:
                        packet = self.codec.decode(fields[b"packet"])
                        await self._consume(packet)
                        self._cursor = sequence
                        self.received += 1
                        await self.redis.eval(_ACK, 2, self.key("inbox", self.node),
                                              self.key("bytes", self.node), sequence,
                                              len(fields[b"packet"]))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.last_refresh = 0
                self.reader_ok = False
                log.warning("Cluster inbox temporarily unavailable: %s", type(exc).__name__)
                await asyncio.sleep(1)

    async def claim(self, runner_id: str, token: str):
        await self.redis.set(self.key("runner", runner_id), token,
                             ex=self.settings.cluster_lease_seconds)

    async def renew(self, runner_id: str, token: str) -> bool:
        return bool(await self.redis.eval(_COMPARE_EXPIRE, 1, self.key("runner", runner_id),
                                          token, self.settings.cluster_lease_seconds))

    async def owns(self, runner_id: str, token: str) -> bool:
        return await self.redis.get(self.key("runner", runner_id)) == token.encode()

    async def release(self, runner_id: str, token: str) -> bool:
        return bool(await self.redis.eval(_COMPARE_DELETE, 1, self.key("runner", runner_id), token))


bus = ClusterBus()
