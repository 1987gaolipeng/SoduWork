# Native screen and conversation relay discovery

The desktop reuses the authenticated account-sync WebSocket; it does not open
another connection. After a screen/relay request commits, the Hub publishes a
`native-discovery` hint to its source device **and owner account**. Hints contain
no instruction, transcript or credentials. The desktop still fetches the queue
and uses the existing consent/claim/acknowledgment authorization paths.

## Polling and compatibility

- Polls are serialized, timed out after 12 seconds, and cancelled on disposal.
  A burst of hints coalesces; hints do not defeat authentication/error backoff.
- Idle HTTP discovery backs off with 20% jitter. Without an acknowledged native
  WebSocket capability it stays within a 20-second fallback interval. Relay
  fallback budgets request duration inside that interval to preserve the legacy
  30-second availability lease. Active screen polling remains 3 seconds and
  active relay polling 5 seconds. Errors back off to 60 seconds.
- The native service advertises its capabilities every 15 seconds. With an
  acknowledged socket, idle HTTP discovery can extend to 60 seconds. Missing
  acknowledgment after 5 seconds or a socket close immediately wakes HTTP
  fallback. A screen-only capability never advertises relay availability.
- New clients talking to old Hubs receive no capability acknowledgment and keep
  the bounded HTTP fallback. Old clients talking to new Hubs continue using the
  legacy `Client.config.personalConversationRelay` lease; writes are throttled
  to 10 seconds. PostgreSQL renewals re-read under a row lock across workers and
  preserve unrelated configuration. Legacy lease expiry remains 30 seconds.
- Deploy the Hub migration and code to all replicas before upgrading clients.
  A rolling pool mixing old and new Hub versions cannot share the new ephemeral
  presence protocol with old code; the compatibility guarantee applies to a
  consistent Hub pool with either old or new clients.

## Availability and identity

New relay presence is ephemeral, with a 30-second TTL, keyed by device, owner,
and device authentication version. It is held in a bounded process-local map
for single-process deployments, and shared Redis for configured clusters. Redis
failure is reported as unavailable, never silently replaced by local online
state. No new-client heartbeat rewrites `Client.config`.

The client checks Hub, device, account and authentication epoch again after
asynchronous discovery/consent and before native effects. Its durable relay
submission fence remains unchanged: a lost acknowledgment cannot resubmit a
native turn. Native capability messages only travel on the authenticated socket;
renderer events cannot wake or advertise this capability.

## Query boundaries

- Empty screen and new relay discovery each execute one queue SELECT, with no
  business-data UPDATE or COMMIT. Authentication is separate and still uses the
  existing last-seen throttling.
- Screen discovery excludes expired rows in SQL and returns at most 20 grants.
  It queries viewer names only for nonempty results. Each new request cleans at
  most 100 expired grants; authorization enforces expiry independently. Migration
  `0079_native_discovery` adds a source/state/expiry index for both paths.
- Relay discovery returns at most 20 jobs and loads their current source
  conversations/devices in one batch. Expired prepared jobs are retired in one
  bounded update instead of per-job commits.

## Focused validation

```powershell
node --test client/tests/native-discovery.test.cjs client/main/remote-screen-source.test.cjs client/main/conversation/account-sync.test.cjs client/tests/personal-conversation-relay.test.cjs client/tests/personal-conversation-relay-runtime.test.cjs client/tests/personal-relay-ipc.test.cjs
cd hub-backend
.\.venv\Scripts\python.exe -m unittest test_native_discovery tests.test_personal_conversation_relay test_remote_screen_protocol test_realtime_account_scope
```

Tests use fake clocks, isolated SQLite, a fake shared Redis, scoped WebSockets,
and a real Pi session with a local model fixture. They cover 20-minute request
budgets, missed push/heartbeat fallback, cancellation, stale identity fencing,
single-send receipts, queue query counts and migration up/down. They do not
constitute a production PostgreSQL/Redis capacity benchmark.
