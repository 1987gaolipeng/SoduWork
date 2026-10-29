"""Bounded runtime governance for purpose-bound plugin MCP tickets.

The signed ticket carries immutable limits.  This module enforces them before
an upstream connector is touched.  Single-instance deployments use bounded
process-local state; clustered deployments atomically coordinate the same
counters, concurrency leases and circuit breaker through the cluster Redis.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import secrets
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass


DEFAULT_MAX_CALLS = 48
DEFAULT_MAX_LISTS = 12
DEFAULT_MAX_CONCURRENT = 2
# Media generation can legitimately take a few minutes.  The limit remains
# bounded per signed turn so a plugin cannot create an unbounded background
# request, while ordinary connectors still finish much sooner in practice.
DEFAULT_TIMEOUT_SECONDS = 180
DEFAULT_FAILURE_THRESHOLD = 3
DEFAULT_COOLDOWN_SECONDS = 45
DEFAULT_MAX_RESULT_CHARS = 500_000


class PluginMcpLimitError(ValueError):
    """A bounded, user-facing runtime policy rejection."""

    def __init__(self, message: str, kind: str, retry_after: int = 0):
        super().__init__(message)
        self.kind = kind
        self.retry_after = max(0, int(retry_after or 0))


@dataclass
class _Turn:
    expires_at: float
    calls: int = 0
    lists: int = 0
    in_flight: int = 0


@dataclass
class _Circuit:
    expires_at: float
    consecutive_failures: int = 0
    blocked_until: float = 0.0


@dataclass(frozen=True)
class Lease:
    turn_key: str
    circuit_key: tuple[str, str] | str
    policy: dict
    distributed: bool = False


_LOCK = asyncio.Lock()
_TURNS: dict[str, _Turn] = {}
_CIRCUITS: dict[tuple[str, str], _Circuit] = {}
log = logging.getLogger(__name__)

_REDIS_ACQUIRE = """
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local blocked = tonumber(redis.call('HGET', KEYS[2], 'blocked') or '0')
if blocked > now then return {0, 4, math.ceil((blocked - now) / 1000)} end
local calls = tonumber(redis.call('HGET', KEYS[1], 'calls') or '0')
local lists = tonumber(redis.call('HGET', KEYS[1], 'lists') or '0')
local inflight = tonumber(redis.call('HGET', KEYS[1], 'inflight') or '0')
if calls >= tonumber(ARGV[2]) then return {0, 1, 0} end
if ARGV[1] == 'list' and lists >= tonumber(ARGV[3]) then return {0, 2, 0} end
if inflight >= tonumber(ARGV[4]) then return {0, 3, 1} end
redis.call('HINCRBY', KEYS[1], 'calls', 1)
if ARGV[1] == 'list' then redis.call('HINCRBY', KEYS[1], 'lists', 1) end
redis.call('HINCRBY', KEYS[1], 'inflight', 1)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5]))
return {1, 0, 0}
"""

_REDIS_RELEASE = """
local inflight = tonumber(redis.call('HINCRBY', KEYS[1], 'inflight', -1))
if inflight < 0 then redis.call('HSET', KEYS[1], 'inflight', 0) end
if ARGV[1] == '1' then
  redis.call('HSET', KEYS[2], 'failures', 0, 'blocked', 0)
elseif ARGV[1] == '-1' then
  local failures = tonumber(redis.call('HINCRBY', KEYS[2], 'failures', 1))
  if failures >= tonumber(ARGV[2]) then
    local clock = redis.call('TIME')
    local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
    redis.call('HSET', KEYS[2], 'blocked', now + tonumber(ARGV[3]) * 1000)
  end
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
return 1
"""


def ticket_claims() -> dict:
    """Claims added to a signed per-turn ticket; clients cannot broaden them."""
    return {
        "jti": secrets.token_urlsafe(12),
        "mcl": DEFAULT_MAX_CALLS,
        "mll": DEFAULT_MAX_LISTS,
        "mcc": DEFAULT_MAX_CONCURRENT,
        "mto": DEFAULT_TIMEOUT_SECONDS,
        "mft": DEFAULT_FAILURE_THRESHOLD,
        "mcd": DEFAULT_COOLDOWN_SECONDS,
        "mrc": DEFAULT_MAX_RESULT_CHARS,
    }


def _integer(claims: dict, key: str, default: int, low: int, high: int) -> int:
    try:
        value = int(claims.get(key, default))
    except (TypeError, ValueError):
        value = default
    return min(high, max(low, value))


def policy(claims: dict) -> dict:
    return {
        "maxCalls": _integer(claims, "mcl", DEFAULT_MAX_CALLS, 1, 200),
        "maxListCalls": _integer(claims, "mll", DEFAULT_MAX_LISTS, 1, 50),
        "maxConcurrent": _integer(
            claims, "mcc", DEFAULT_MAX_CONCURRENT, 1, 8),
        "timeoutSeconds": _integer(
            claims, "mto", DEFAULT_TIMEOUT_SECONDS, 3, 300),
        "failureThreshold": _integer(
            claims, "mft", DEFAULT_FAILURE_THRESHOLD, 1, 10),
        "cooldownSeconds": _integer(
            claims, "mcd", DEFAULT_COOLDOWN_SECONDS, 5, 300),
        "maxResultChars": _integer(
            claims, "mrc", DEFAULT_MAX_RESULT_CHARS, 1_000, 500_000),
    }


def public_policy(claims: dict) -> dict:
    """Safe diagnostics returned with the grant; no internal state is exposed."""
    current = policy(claims)
    return {
        "maxCalls": current["maxCalls"],
        "timeoutSeconds": current["timeoutSeconds"],
        "maxConcurrent": current["maxConcurrent"],
        "maxResultChars": current["maxResultChars"],
    }


def _turn_key(claims: dict) -> str:
    explicit = str(claims.get("jti") or "").strip()
    if explicit:
        return explicit[:96]
    raw = "|".join(str(claims.get(key) or "") for key in ("cid", "uid", "ref", "exp"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def _ttl(claims: dict) -> float:
    try:
        remaining = float(claims.get("exp") or 0) - time.time()
    except (TypeError, ValueError):
        remaining = 1800.0
    return min(7200.0, max(60.0, remaining))


def _cluster_runtime():
    from .cluster_bus import bus
    return bus


def _cluster_keys(claims: dict, server: str) -> tuple[str, str]:
    bus = _cluster_runtime()
    turn = hashlib.sha256(_turn_key(claims).encode()).hexdigest()[:40]
    circuit_raw = (str(claims.get("cid") or "")[:64] + "\x00" +
                   str(server or "")[:128])
    circuit = hashlib.sha256(circuit_raw.encode()).hexdigest()[:40]
    return (bus.key("plugin-mcp-turn", turn),
            bus.key("plugin-mcp-circuit", circuit))


async def _acquire_distributed(claims: dict, server: str, operation: str,
                               current: dict) -> Lease:
    bus = _cluster_runtime()
    if bus.redis is None:
        raise PluginMcpLimitError(
            "插件调用治理服务暂不可用，请稍后重试", "governance-unavailable", 3)
    turn_key, circuit_key = _cluster_keys(claims, server)
    ttl = max(60, int(_ttl(claims) + 0.999))
    try:
        raw = await bus.redis.eval(
            _REDIS_ACQUIRE, 2, turn_key, circuit_key, operation,
            current["maxCalls"], current["maxListCalls"],
            current["maxConcurrent"], ttl)
    except Exception as exc:
        raise PluginMcpLimitError(
            "插件调用治理服务暂不可用，请稍后重试",
            "governance-unavailable", 3) from exc
    values = [int(item or 0) for item in (raw or [])]
    if values and values[0] == 1:
        return Lease(turn_key, circuit_key, {**current, "leaseTtl": ttl}, True)
    code = values[1] if len(values) > 1 else 0
    retry = values[2] if len(values) > 2 else 0
    if code == 1:
        raise PluginMcpLimitError(
            f"本轮插件连接调用已达到 {current['maxCalls']} 次上限。"
            "请先确认已有结果；确需继续时发起新一轮对话。", "call-budget")
    if code == 2:
        raise PluginMcpLimitError(
            f"本轮工具清单读取已达到 {current['maxListCalls']} 次上限，"
            "请直接使用已经取得的工具定义。", "list-budget")
    if code == 3:
        raise PluginMcpLimitError(
            f"当前已有 {current['maxConcurrent']} 个插件调用在执行，"
            "请等待它们完成后重试。", "concurrency", max(1, retry))
    if code == 4:
        raise PluginMcpLimitError(
            f"连接连续失败，已暂停 {max(1, retry)} 秒，避免反复冲击业务系统。",
            "circuit-open", max(1, retry))
    raise PluginMcpLimitError(
        "插件调用治理服务返回了无效结果，请稍后重试",
        "governance-unavailable", 3)


def _sweep(now: float) -> None:
    for key in [key for key, item in _TURNS.items() if item.expires_at <= now]:
        _TURNS.pop(key, None)
    for key in [key for key, item in _CIRCUITS.items() if item.expires_at <= now]:
        _CIRCUITS.pop(key, None)
    # A malformed flood must not turn policy bookkeeping into a memory sink.
    if len(_TURNS) > 4096:
        for key, _ in sorted(_TURNS.items(), key=lambda item: item[1].expires_at)[:1024]:
            _TURNS.pop(key, None)
    if len(_CIRCUITS) > 8192:
        for key, _ in sorted(
                _CIRCUITS.items(), key=lambda item: item[1].expires_at)[:2048]:
            _CIRCUITS.pop(key, None)


async def acquire(claims: dict, server: str, operation: str) -> Lease:
    current = policy(claims)
    bus = _cluster_runtime()
    if bus.enabled:
        return await _acquire_distributed(claims, server, operation, current)
    now = time.monotonic()
    turn_key = _turn_key(claims)
    circuit_key = (str(claims.get("cid") or "")[:64], str(server or "")[:128])
    async with _LOCK:
        _sweep(now)
        turn = _TURNS.setdefault(
            turn_key, _Turn(expires_at=now + _ttl(claims)))
        circuit = _CIRCUITS.setdefault(
            circuit_key, _Circuit(expires_at=now + _ttl(claims)))
        if circuit.blocked_until > now:
            retry = max(1, int(circuit.blocked_until - now + 0.999))
            raise PluginMcpLimitError(
                f"连接连续失败，已暂停 {retry} 秒，避免反复冲击业务系统。",
                "circuit-open", retry)
        if turn.calls >= current["maxCalls"]:
            raise PluginMcpLimitError(
                f"本轮插件连接调用已达到 {current['maxCalls']} 次上限。"
                "请先确认已有结果；确需继续时发起新一轮对话。",
                "call-budget")
        if operation == "list" and turn.lists >= current["maxListCalls"]:
            raise PluginMcpLimitError(
                f"本轮工具清单读取已达到 {current['maxListCalls']} 次上限，"
                "请直接使用已经取得的工具定义。",
                "list-budget")
        if turn.in_flight >= current["maxConcurrent"]:
            raise PluginMcpLimitError(
                f"当前已有 {current['maxConcurrent']} 个插件调用在执行，"
                "请等待它们完成后重试。",
                "concurrency", 1)
        turn.calls += 1
        if operation == "list":
            turn.lists += 1
        turn.in_flight += 1
        return Lease(turn_key, circuit_key, current)


async def release(lease: Lease, success: bool | None) -> None:
    if lease.distributed:
        bus = _cluster_runtime()
        if bus.redis is None:
            log.error("Redis unavailable while releasing plugin MCP lease")
            return
        outcome = "0" if success is None else ("1" if success else "-1")
        try:
            await bus.redis.eval(
                _REDIS_RELEASE, 2, lease.turn_key, lease.circuit_key,
                outcome, lease.policy["failureThreshold"],
                lease.policy["cooldownSeconds"],
                max(60, int(lease.policy.get("leaseTtl") or 7200)))
        except Exception:
            # Do not turn an already-completed paid provider call into a retry.
            # The Redis lease remains bounded and expires automatically.
            log.exception("Failed to release distributed plugin MCP lease")
        return
    now = time.monotonic()
    async with _LOCK:
        turn = _TURNS.get(lease.turn_key)
        if turn is not None:
            turn.in_flight = max(0, turn.in_flight - 1)
        circuit = _CIRCUITS.get(lease.circuit_key)
        if circuit is None or success is None:
            return
        if success:
            circuit.consecutive_failures = 0
            circuit.blocked_until = 0.0
            return
        circuit.consecutive_failures += 1
        if circuit.consecutive_failures >= lease.policy["failureThreshold"]:
            circuit.blocked_until = now + lease.policy["cooldownSeconds"]


@asynccontextmanager
async def governed(claims: dict, server: str, operation: str):
    lease = await acquire(claims, server, operation)
    try:
        yield lease.policy
    except asyncio.CancelledError:
        # Caller cancellation is not an upstream connector failure and must
        # never contribute to the shared circuit-breaker failure count.
        await release(lease, None)
        raise
    except Exception:
        await release(lease, False)
        raise
    else:
        await release(lease, True)


def reset_for_tests() -> None:
    _TURNS.clear()
    _CIRCUITS.clear()
