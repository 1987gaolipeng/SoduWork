"""Small credential-free status frames for the owning desktop process."""
import json
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


def error_code(error):
    status = getattr(getattr(error, "response", None), "status_code", None)
    if status in (401, 403):
        return "AUTH_REQUIRED"
    if isinstance(error, TimeoutError):
        return "HANDSHAKE_TIMEOUT"
    return "CONNECTION_FAILED"
