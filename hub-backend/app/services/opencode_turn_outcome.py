"""Recover native OpenCode finish reasons omitted by its ACP response.

The observer reports identifiers, settled token counts and stop reasons over the owned child's
stderr pipe. It neither reads native databases nor persists prompts or secrets.
"""
from __future__ import annotations

import json
from pathlib import Path
import secrets
import tempfile
import threading

ENV = "SODUWORK_OPENCODE_OUTCOME"
PREFIX = "SODUWORK_OPENCODE_OUTCOME:"
MISSING = "OpenCode did not confirm the current turn outcome; execution was not completed."


class OutcomeError(RuntimeError):
    pass

_PLUGIN = """const token = process.env.SODUWORK_OPENCODE_OUTCOME;
delete process.env.SODUWORK_OPENCODE_OUTCOME;
export default async () => {
  const turns = new Map();
  // OpenCode 1.18.18 MessageID.ascending encodes time + a process counter in
  // the first twelve hex digits. The random suffix is never an ordering key.
  const order = id => typeof id === 'string' && /^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/.test(id)
    ? id.slice(4, 16) : '';
  const send = value => process.stderr.write('SODUWORK_OPENCODE_OUTCOME:' +
    JSON.stringify({ token, ...value }) + '\\n');
  send({ kind: 'ready' });
  return {
    'chat.message': async (input, output) => {
      const sid = input.sessionID, user = output.message?.id;
      if (!sid || !order(user)) throw new Error('OpenCode turn identity is unavailable');
      const invocation = (turns.get(sid)?.invocation || 0) + 1;
      turns.set(sid, { invocation, user, floor: order(user), users: new Set([user]), model: input.model,
        reported: new Set(), latest: '', message: '', reason: '' });
      send({ kind: 'begin', sid, user, invocation });
    },
    event: async ({ event }) => {
      const props = event.properties || {};
      if (event.type === 'message.updated') {
        const info = props.info || {}, turn = turns.get(info.sessionID);
        if (!turn || !order(info.id) || order(info.id) <= turn.floor) return;
        // Auto-compaction creates native replay/continue users without calling
        // chat.message. Only fresh users observed in this owned session qualify.
        if (info.role === 'user') { turn.users.add(info.id); return; }
        if (info.role !== 'assistant' || !turn.users.has(info.parentID) || order(info.parentID) >= order(info.id)) return;
        const t = info.tokens;
        if (info.time?.completed && t && turn.model?.modelID && !turn.reported.has(info.id) &&
            turn.model?.providerID === info.providerID && turn.model?.modelID === info.modelID) {
          const read = t.cache?.read ?? 0, write = t.cache?.write ?? 0, thought = t.reasoning ?? 0;
          const total = t.total ?? (t.input + t.output + thought + read + write);
          if (total > 0) {
            turn.reported.add(info.id);
            send({kind: 'usage', sid: info.sessionID, user: turn.user, invocation: turn.invocation,
              usage: {inputTokens: t.input, outputTokens: t.output, totalTokens: total,
                cachedReadTokens: read, cachedWriteTokens: write, thoughtTokens: thought}});
          }
        }
        if (info.summary || order(info.id) < turn.latest) return;
        if (order(info.id) === turn.latest && info.id !== turn.message) { turn.invalid = true; return; }
        if (info.id !== turn.message) { turn.message = info.id; turn.latest = order(info.id); turn.reason = ''; }
        if (typeof info.finish === 'string') turn.reason = info.finish;
      }
      if (event.type === 'session.status' && props.status?.type === 'idle') {
        const turn = turns.get(props.sessionID);
        if (turn) send({ kind: 'end', sid: props.sessionID, user: turn.user, invocation: turn.invocation, reason: turn.invalid ? '' : turn.reason });
      }
    },
  };
};
"""


class Observer:
    def __init__(self):
        self.token = secrets.token_hex(24)
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-opencode-outcome-")
        self.path = Path(self.temp.name) / "outcome.mjs"
        self.path.write_text(_PLUGIN, encoding="utf-8")
        self.condition = threading.Condition()
        self.ready = False
        self.sid = ""
        self.user = ""
        self.reason = None
        self.invocations = {}
        self.invocation = 0
        self.invalid = False
        self.on_usage = None

    def environment(self, env: dict) -> dict:
        result = dict(env)
        config = json.loads(result.get("OPENCODE_CONFIG_CONTENT") or "{}")
        config["plugin"] = [*(config.get("plugin") or []), self.path.as_uri()]
        result["OPENCODE_CONFIG_CONTENT"] = json.dumps(config, ensure_ascii=False)
        result[ENV] = self.token
        result.pop("OPENCODE_PURE", None)
        return result

    def consume(self, line: str) -> bool:
        if not line.startswith(PREFIX):
            return False
        # Never publish an internal marker, including malformed/untrusted ones.
        try:
            row = json.loads(line[len(PREFIX):]) if len(line) < 2048 else {}
        except ValueError:
            return True
        if not isinstance(row, dict) or row.get("token") != self.token:
            return True
        with self.condition:
            if row.get("kind") == "ready":
                self.ready = True
            elif (self.sid and row.get("sid") == self.sid
                  and type(row.get("invocation")) is int and row["invocation"] == self.invocation):
                user = row.get("user")
                if not isinstance(user, str) or not user or len(user) > 200:
                    return True
                if row.get("kind") == "begin":
                    if self.user and self.user != user:
                        self.invalid = True
                        self.reason = ""
                    elif not self.user:
                        self.user, self.reason = user, None
                elif row.get("kind") == "usage" and user == self.user and not self.invalid and self.on_usage:
                    self.on_usage(row.get("usage"))
                elif row.get("kind") == "end" and user == self.user:
                    reason = row.get("reason")
                    self.reason = reason if isinstance(reason, str) and len(reason) < 80 else ""
            self.condition.notify_all()
        return True

    def begin(self, sid: str):
        with self.condition:
            if not self.condition.wait_for(lambda: self.ready, timeout=1):
                raise OutcomeError(MISSING)
            self.sid, self.user, self.reason = sid, "", None
            self.invalid = False
            self.invocation = self.invocations.get(sid, 0) + 1
            self.invocations[sid] = self.invocation

    def finish(self, *, interrupted: bool = False) -> str:
        with self.condition:
            # stdout and stderr can race. Match the plugin's per-session prompt
            # ordinal, never the order in which the stderr reader catches up.
            if not self.condition.wait_for(lambda: self.reason is not None, timeout=1):
                raise OutcomeError(MISSING)
            reason = self.reason
            self.sid = ""
            if not self.invalid and interrupted and reason == "tool-calls":
                return "cancelled"
            if self.invalid or reason not in {"stop", "length", "max_tokens"}:
                raise OutcomeError(MISSING)
            return reason

    def close(self):
        self.temp.cleanup()
