"""Evidence from the current Runner turn, without replaying or inventing work."""
from __future__ import annotations


NO_OUTPUT = "本轮模型没有返回可用内容，已有会话和工作进度已保留；请重试或切换模型。"
THINKING_ONLY = "本轮只返回了思考过程，还没有最终答复；已有进度已保留，请继续或重试。"


def interactive(run: dict) -> bool:
    mode = str(run.get("conversationMode") or "")
    if mode:
        return mode == "adaptive"
    # Older local dialogue archives did not persist conversationMode. A human
    # message in their event journal must not become unattended authorization.
    return any(row.get("kind") == "user" for row in run.get("lines") or [])


def current_rows(run: dict) -> list[dict]:
    rows = [row for row in run.get("lines") or [] if isinstance(row, dict)]
    boundary = run.get("turnStartSeq")
    if isinstance(boundary, int) and not isinstance(boundary, bool):
        return [row for row in rows if int(row.get("seq") or 0) > boundary]
    # Read-only compatibility for older archives, without assuming a historical
    # answer belongs to the latest visible user message.
    for index in range(len(rows) - 1, -1, -1):
        if rows[index].get("kind") == "user":
            return rows[index + 1:]
    return rows


def failure(run: dict, terminal: dict) -> dict:
    if not interactive(run) or not isinstance(run.get("turnStartSeq"), int):
        return {}
    if str(terminal.get("result") or "").strip():
        return {}
    thinking = False
    for row in current_rows(run):
        kind = row.get("kind")
        if kind == "say" and str(row.get("full") or row.get("text") or "").strip():
            return {}
        if kind == "thinking" and str(row.get("full") or row.get("text") or "").strip():
            thinking = True
        if kind == "do" and row.get("tool"):
            return {}
        if kind == "out" and row.get("callId"):
            return {}
        if kind == "usage":
            # Neither prompt nor billed completion tokens prove an answer was
            # actually delivered. Providers can count hidden reasoning here.
            usage = row.get("usage") or {}
            thinking = thinking or float(usage.get("reasoning") or 0) > 0
    return {"kind": "execution_incomplete" if thinking else "execution_no_output",
            "reason": THINKING_ONLY if thinking else NO_OUTPUT}
