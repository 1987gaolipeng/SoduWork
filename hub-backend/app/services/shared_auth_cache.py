"""Shared, small authentication snapshots. PostgreSQL remains authoritative.

No process-local allow cache. Permission writers fence readers BEFORE changing
SQL state; generation-checked fills cannot resurrect pre-revocation snapshots.
Writer markers deliberately do not expire: abandoned transactions degrade to DB
reads until an operator has verified termination and cleared their marker.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid

log = logging.getLogger("uvicorn.error")

# Each scope is one hash. Missing generation gets a random identity, never a
# reusable counter. Payloads live separately and carry both scope generations.
_READ = """
local generations = {}
for i=1,2 do
  if not redis.call('HGET',KEYS[i],'generation') then
    redis.call('HSET',KEYS[i],'generation',ARGV[i])
  end
  if redis.call('HLEN',KEYS[i]) > 1 then return {'blocked'} end
  generations[i] = redis.call('HGET',KEYS[i],'generation')
end
local payload = redis.call('GET',KEYS[3])
return {generations[1], generations[2], payload or ''}
"""
_FILL = """
for i=1,2 do
  if redis.call('HLEN',KEYS[i]) ~= 1 or
     redis.call('HGET',KEYS[i],'generation') ~= ARGV[i] then return 0 end
end
redis.call('SET',KEYS[3],ARGV[3],'EX',ARGV[4])
return 1
"""
_FENCE = """
for i=1,#KEYS do
  redis.call('HSET',KEYS[i],'generation',ARGV[2],ARGV[1],'1')
end
return 1
"""
_RELEASE = """
for i=1,#KEYS do
  redis.call('HSET',KEYS[i],'generation',ARGV[2])
  redis.call('HDEL',KEYS[i],ARGV[1])
end
return 1
"""


class AuthCacheUnavailable(RuntimeError):
    """A security mutation must not commit without its shared write fence."""


class SharedAuthCache:
    def __init__(self, redis, namespace="soduwork", ttl_seconds=60, timeout_seconds=.25):
        self.redis = redis
        self.prefix = namespace + ":auth:v1:"
        self.ttl = ttl_seconds
        self.timeout = timeout_seconds

    def scope(self, kind, identity):
        return f"{self.prefix}scope:{kind}:{identity}"

    def keys(self, kind, identity):
        return [self.scope(kind, "*"), self.scope(kind, identity),
                f"{self.prefix}value:{kind}:{identity}"]

    async def _eval(self, script, keys, *args):
        async with asyncio.timeout(self.timeout):
            return await self.redis.eval(script, len(keys), *keys, *args)

    async def load(self, kind, identity, loader):
        keys = self.keys(kind, identity)
        try:
            read = await self._eval(_READ, keys, uuid.uuid4().hex, uuid.uuid4().hex)
            read = [v.decode() if isinstance(v, bytes) else v for v in read]
            blocked = read == ["blocked"]
            first, second, raw = read if not blocked else (None, None, "")
            if not blocked and raw:
                envelope = json.loads(raw)
                if (isinstance(envelope, list) and len(envelope) == 3 and
                        envelope[:2] == [first, second] and isinstance(envelope[2], dict)):
                    return envelope[2]
        except asyncio.CancelledError:
            raise
        except Exception:
            return await loader()
        if blocked:
            return await loader()
        value = await loader()
        if value is not None:
            raw = json.dumps([first, second, value], separators=(",", ":"))
            # Bound cache values independently of business JSON/credentials.
            if len(raw.encode()) <= 16384:
                try:
                    await self._eval(_FILL, keys, first, second, raw, self.ttl)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    pass  # A read miss must not fail solely because filling failed.
        return value

    async def fence(self, token, subjects):
        if not subjects:
            return
        try:
            await self._eval(_FENCE, [self.scope(*s) for s in sorted(subjects)],
                             "writer:" + token, uuid.uuid4().hex)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise AuthCacheUnavailable("Authentication cache unavailable; permission change not committed") from exc

    async def release(self, token, subjects):
        if not subjects:
            return
        # A failure MUST leave the marker intact. The DB may already be committed.
        await self._eval(_RELEASE, [self.scope(*s) for s in sorted(subjects)],
                         "writer:" + token, uuid.uuid4().hex)


_cache = None


class PinnedAuthConnection:
    """Mixin for the dedicated Redis pool, including SSL connections.

    Authentication metadata must survive outages without eviction. A new Redis
    incarnation stays unavailable to this cache until operators drain permission
    writers and deliberately provision a new run-id pin and empty namespace.
    """
    expected_run_id = ""

    async def on_connect(self):
        await super().on_connect()
        try:
            await self.send_command("INFO")
            raw = await self.read_response()
            if isinstance(raw, bytes):
                raw = raw.decode()
            info = dict(line.split(":", 1) for line in raw.splitlines()
                        if line and not line.startswith("#") and ":" in line)
            if (info.get("run_id") != self.expected_run_id or
                    info.get("maxmemory_policy") != "noeviction"):
                raise AuthCacheUnavailable("Authentication Redis requires maintenance revalidation")
        except BaseException:
            await self.disconnect()
            raise


def get_cache():
    global _cache
    from ..config import get_settings
    settings = get_settings()
    if not (settings.auth_cache_enabled or settings.auth_cache_fencing_enabled):
        return None
    if _cache is None:
        if not settings.cluster_redis_url:
            raise AuthCacheUnavailable("AUTH_CACHE_ENABLED requires shared Redis")
        from redis.asyncio import Redis, BlockingConnectionPool
        import re
        if not re.fullmatch(r"[a-f0-9]{40}", settings.auth_cache_redis_run_id):
            raise AuthCacheUnavailable("AUTH_CACHE_REDIS_RUN_ID must pin the shared Redis incarnation")
        # Separate pool: polling cannot occupy Runner/cluster control connections.
        pool = BlockingConnectionPool.from_url(
            settings.cluster_redis_url, max_connections=32, timeout=.2,
            socket_connect_timeout=.2, socket_timeout=.2)
        pool.connection_class = type("AuthenticationRedisConnection",
            (PinnedAuthConnection, pool.connection_class),
            {"expected_run_id": settings.auth_cache_redis_run_id})
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,48}", settings.auth_cache_generation):
            raise AuthCacheUnavailable("AUTH_CACHE_GENERATION must be a short deployment identifier")
        _cache = SharedAuthCache(Redis(connection_pool=pool),
            settings.cluster_namespace + ":" + settings.auth_cache_generation)
    return _cache


def reads_enabled():
    from ..config import get_settings
    return get_settings().auth_cache_enabled


async def load(kind, identity, loader):
    if not reads_enabled():
        return await loader()
    cache = get_cache()
    if cache is None:
        return await loader()
    return await cache.load(kind, str(identity), loader)


async def close():
    global _cache
    cache, _cache = _cache, None
    if cache is not None:
        try:
            await cache.redis.aclose()
        finally:
            await cache.redis.connection_pool.disconnect()
