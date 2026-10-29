"""Bounded recovery for CLI turns that exit before Git delivery is finished.

The process exit code is only a transport fact. Pi can exit with code 0 after a
malformed tool call, leaving real edits in the worktree and a one-character final
reply. This module recognises that narrow shape and asks the same session to finish
once. It deliberately does not replace the workflow no-progress/delivery gates.
"""
from __future__ import annotations

import os
import re

from . import git_ops


_RECOVERY_LIMIT = max(0, int(os.environ.get("SODUWORK_LOCAL_COMPLETION_RETRIES") or 1))
_TOOL_ABORT = re.compile(
    r"Validation failed for tool|must have required properties|Received arguments:\s*\{\s*\}",
    re.I,
)
RECOVERY_PROMPT = (
    "SoduWork 检测到上一轮在工具调用参数异常后提前退出，但当前 Git 工作区仍有未提交修改。\n"
    "请保留并检查现有工作，不要重新初始化或重复已经完成的部分。先查看 git status 和 git diff，"
    "完成剩余修改与测试，然后提交并推送到本任务指定的远端分支。"
    "结束前必须确认工作区状态、提交号和远端分支；不要只解释过程。"
)


def _text(item: dict) -> str:
    return str(item.get("full") or item.get("text") or "").strip()


def assess(run: dict) -> dict:
    """Return a recovery instruction only for a demonstrably incomplete Git turn."""
    artifact_mode = str(
        run.get("artifactMode") or ("git" if run.get("codeTask") else ""))
    if artifact_mode != "git":
        return {}
    if int(run.get("completionRetries") or 0) >= _RECOVERY_LIMIT:
        return {}

    lines = [item for item in (run.get("lines") or []) if isinstance(item, dict)]
    recent = "\n".join(_text(item) for item in lines[-24:])
    says = [
        _text(item) for item in lines
        if item.get("kind") == "say" and _text(item)
    ]
    final = says[-1] if says else ""
    malformed_tool = bool(_TOOL_ABORT.search(recent))
    abnormal_final = len(final) <= 12
    if not (malformed_tool or abnormal_final):
        return {}

    pending = git_ops.worktree_pending_changes(str(run.get("ws") or ""))
    if not pending.get("ok") or not pending.get("dirty"):
        return {}
    reason = "工具调用参数异常" if malformed_tool else "最终答复异常中断"
    return {
        "recover": True,
        "reason": reason,
        "prompt": RECOVERY_PROMPT,
        "pendingFiles": int(pending.get("count") or 0),
    }
