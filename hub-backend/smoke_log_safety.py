"""Offline regression for credential redaction in Uvicorn/WebSocket logs."""
import logging
from urllib.parse import unquote

from app.log_safety import SensitiveLogFilter, install_log_redaction, redact_log_text


N = 0


def ok(condition, label):
    global N
    assert condition, label
    N += 1
    print(f"  ok {N:02d} - {label}")


raw = '/api/v1/ws?device=desk-1&secret=top-secret&task=t-1'
safe = redact_log_text(raw)
ok("top-secret" not in safe, "query secret is removed")
ok("device=desk-1" in safe and "task=t-1" in safe, "non-secret context remains")
ok(redact_log_text(safe) == safe, "query redaction is idempotent")

mixed = '/runner?token=runner-token&runner_key=runner-key&apiKey=model-key'
safe = redact_log_text(mixed)
ok(not any(value in safe for value in ("runner-token", "runner-key", "model-key")),
   "token and key aliases are removed")

# The attachment download has no session dependency at all: its ticket *is* the
# authorization boundary, so a leaked access-log line is a replayable credential
# for as long as it lives.  Pin the real generator, not a hand-written shape.
from app.services import resource_access  # noqa: E402

url = resource_access.attachment_url("att-1234")
ticket = url.split("ticket=", 1)[1]
ok(resource_access.verify_attachment("att-1234", unquote(ticket)),
   "the generated attachment ticket really authorizes the download")
access_line = f'127.0.0.1:52001 - "GET {url} HTTP/1.1" 200'
safe = redact_log_text(access_line)
ok(ticket not in safe and unquote(ticket) not in safe,
   "attachment ticket is removed from the access log line")
ok("/api/v1/attachments/att-1234" in safe and "200" in safe,
   "the attachment id and status still identify the request")
ok(redact_log_text(safe) == safe, "attachment redaction is idempotent")

headers = 'Authorization: Bearer abc.def X-Soduwork-Secret=desk-secret'
safe = redact_log_text(headers)
ok("abc.def" not in safe and "desk-secret" not in safe, "header credentials are removed")
ok(redact_log_text(safe) == safe, "header redaction is idempotent")

payload = '{"secret":"json-secret","device":"desk-1"}'
safe = redact_log_text(payload)
ok("json-secret" not in safe and '"device":"desk-1"' in safe,
   "structured secret is removed without hiding context")

record = logging.LogRecord("uvicorn.error", logging.INFO, __file__, 1,
                           '%s - "WebSocket %s" [accepted]',
                           (("127.0.0.1", 1234), raw), None)
SensitiveLogFilter().filter(record)
rendered = record.getMessage()
ok("top-secret" not in rendered and "WebSocket" in rendered,
   "deferred logging arguments are scrubbed")

install_log_redaction()
install_log_redaction()
for logger_name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
    filters = logging.getLogger(logger_name).filters
    ok(sum(isinstance(item, SensitiveLogFilter) for item in filters) == 1,
       f"{logger_name} installation is idempotent")

# Redact secret values in dictionaries and deferred log arguments even without a secret= label.
record = logging.LogRecord("uvicorn.error", logging.INFO, __file__, 1,
                           "%s", ({"refresh_token": "refresh-fixture-value",
                                   "nested": [{"Password": "password-fixture-value",
                                               "Authorization": "Device device-fixture-value"}],
                                   "status": "failed", "count": 3},), None)
SensitiveLogFilter().filter(record)
rendered = record.getMessage()
ok(not any(value in rendered for value in (
    "refresh-fixture-value", "password-fixture-value", "device-fixture-value")),
   "nested structured credentials are removed by field name")
ok("failed" in rendered and "3" in rendered, "structured operational context remains")

for raw_value in [
    "Authorization: Device device-fixture-value",
    '{"refresh_token":"refresh-fixture-value","password":"password-fixture-value"}',
    "/callback?refresh_token=refresh-fixture-value&client_secret=secret-fixture-value",
]:
    safe = redact_log_text(raw_value)
    ok("fixture-value" not in safe, "device sessions and refresh credentials are removed")
    ok(redact_log_text(safe) == safe, "expanded credential redaction is idempotent")

print(f"\nsmoke_log_safety: {N} assertions passed")
