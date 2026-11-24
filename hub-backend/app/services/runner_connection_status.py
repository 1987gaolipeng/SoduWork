"""Small credential-free status frames for the owning desktop process."""
import json
import asyncio
import random
import sys


def report(runner, state, code=""):
    if not getattr(runner, "desktop_owned", False):
        return
    _write(state, code)


def report_identity_startup_failure(error, *, desktop_owned):
    """Report private identity storage failure before a Runner can be created."""
    if desktop_owned:
        code = "IDENTITY_STORAGE_FAILED" if isinstance(error, OSError) else "IDENTITY_RECOVERY_FAILED"
        _write("error", code)


def _write(state, code):
    try:
        sys.stdout.write("@@SODUWORK_RUNNER_STATUS@@" + json.dumps({"state": state, "code": code}) + "\n")
        sys.stdout.flush()
    except (OSError, ValueError):
        pass  # Parent pipe closure is handled by runner_lifecycle.


class RunnerAuthorizationRejected(ConnectionError):
    """An authenticated transport rejected the Runner's hello authorization."""


def error_code(error):
    if isinstance(error, RunnerAuthorizationRejected):
        return "AUTH_REQUIRED"
    status = getattr(getattr(error, "response", None), "status_code", None)
    if status in (401, 403):
        return "AUTH_REQUIRED"
    if close_code(error) in (4401, 4403):
        return "AUTH_REQUIRED"
    if isinstance(error, TimeoutError):
        return "HANDSHAKE_TIMEOUT"
    return "CONNECTION_FAILED"


def close_code(error):
    """Only expose protocol numbers, never peer-supplied exception/reason text."""
    value = getattr(getattr(error, "rcvd", None), "code", None)
    return value if isinstance(value, int) else None


class ReconnectPolicy:
    """Bound reconnect traffic without trapping server-side reactivation.

    A welcome followed by another short disconnect does not reset backoff.
    Authentication remains a low-frequency probe because an offline Runner
    cannot receive the administrator's activation event.
    """
    STABLE_SECONDS = 60

    def __init__(self, base=5, jitter=None):
        self.base = base
        self.failures = 0
        self.jitter = jitter or random.uniform

    def delay(self, code, online_seconds=0):
        if online_seconds >= self.STABLE_SECONDS:
            self.failures = 0
        self.failures = min(self.failures + 1, 8)
        if code in ("AUTH_REQUIRED", "IDENTITY_CONFLICT"):
            return self.jitter(60, 90)
        ceiling = min(60, self.base * 2 ** (self.failures - 1))
        return self.jitter(ceiling * 0.8, ceiling)


async def wait_to_retry(stopped, retry, seconds):
    """Private parent retries and shutdown interrupt a cooldown without orphan tasks."""
    jobs = [asyncio.create_task(event.wait()) for event in (stopped, retry)]
    try:
        await asyncio.wait(jobs, timeout=seconds, return_when=asyncio.FIRST_COMPLETED)
        requested = retry.is_set()
        retry.clear()
        return requested
    finally:
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
