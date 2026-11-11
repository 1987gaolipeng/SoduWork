"""Provider-neutral execution event compaction regression checks."""
from app.services import execution_event_policy as policy
from app.services import local_stream


def check(name, condition):
    if not condition:
        raise AssertionError(name)


provider_events = {
    "OpenCode": {"type": "text", "part": {"id": "oc-1", "text": "same progress"}},
    "Pi": {"type": "message_update", "assistantMessageEvent": {
        "id": "pi-1", "type": "text_end", "content": "same progress"}},
    "Codex": {"type": "item.completed", "item": {
        "id": "cx-1", "type": "agent_message", "text": "same progress"}},
    "Claude": {"type": "assistant", "message": {
        "id": "cl-1", "content": [{"type": "text", "text": "same progress"}]}},
}
for provider, message in provider_events.items():
    parsed = local_stream._items_from(message)
    policy.tag_source_ids(message, parsed)
    check(provider + " parser produces one identified assistant event",
          len(parsed) == 1
          and parsed[0].get("kind") == "say"
          and bool(parsed[0].get("_sourceId")))

run = {"round": 1, "segment": 1, "lines": []}
first = [{"kind": "say", "text": "browser acceptance in progress"}]
policy.tag_source_ids({"type": "item.completed", "item": {"id": "codex-1"}}, first)
accepted = policy.filter_new(run, first)
check("Codex provider identity is retained", accepted[0].get("_sourceId"))
run["lines"].extend(accepted)

replayed = [{"kind": "say", "text": "browser acceptance in progress"}]
policy.tag_source_ids({"type": "item.completed", "item": {"id": "codex-1"}}, replayed)
check("same provider event replay is idempotent", policy.filter_new(run, replayed) == [])

rephrased_id = [{"kind": "say", "text": "browser acceptance in progress"}]
policy.tag_source_ids(
    {"assistantMessageEvent": {"id": "pi-2", "type": "text_end"}}, rephrased_id)
check("same narration from another base is compacted in one round",
      policy.filter_new(run, rephrased_id) == [])

tools = policy.filter_new(run, [
    {"kind": "do", "tool": "bash", "text": "npm test"},
    {"kind": "do", "tool": "bash", "text": "npm test"},
])
check("repeated tool actions remain auditable", len(tools) == 2)

run["round"] = 2
next_round = policy.filter_new(
    run, [{"kind": "say", "text": "browser acceptance in progress"}])
check("a new work round may say the same thing again", len(next_round) == 1)

visible = policy.visible_items([
    {"seq": 1, "kind": "say", "text": "checking page", "round": 1},
    {"seq": 2, "kind": "do", "tool": "browser", "text": "open", "round": 1},
    {"seq": 3, "kind": "say", "text": "checking page", "round": 1},
    {"seq": 4, "kind": "user", "text": "check again", "round": 2},
    {"seq": 5, "kind": "say", "text": "checking page", "round": 2},
])
check("historical product view removes only same-turn narration",
      [row["seq"] for row in visible] == [1, 2, 4, 5])

print("execution event policy: 11 assertions passed")
