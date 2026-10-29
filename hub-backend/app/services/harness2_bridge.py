"""Harness² native interactive execution and opt-in text refinement experiments.

Ordinary turns use the same immediate ACP tool loop as OpenCode. Explicit research
runs can refine instructions, never permissions or executable plugins.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    __package__ = "app.services"

from .harness2_runtime import MODEL_ENV, ROOT_ENV, EXECUTOR_ENV, CONTINUE_ENV, VERSION
from .harness2_errors import Harness2Error, StructuredFailure

MAX_RESPONSE = 2 * 1024 * 1024


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # A model endpoint redirect must not forward its Authorization credential.
        return None


def complete(model: dict, messages: list[dict], on_usage=None, *, timeout: float = 20) -> str:
    """One bounded, tool-free inference; provider errors never expose raw bodies."""
    base = str(model.get("base") or "").rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise StructuredFailure("model_config")
    if not all(model.get(key) for key in ("key", "model")):
        raise StructuredFailure("model_config")
    anthropic = model.get("kind") == "anthropic"
    output_limit = model.get("maxOutputTokens", 8192)
    if type(output_limit) is not int or not 1 <= output_limit <= 262144:
        raise StructuredFailure("model_config")
    headers = {"Content-Type": "application/json"}
    if anthropic:
        url = base + ("/messages" if parsed.path.rstrip("/").endswith("/v1") else "/v1/messages")
        headers.update({"x-api-key": str(model["key"]), "anthropic-version": "2023-06-01"})
        body = {"model": model["model"], "max_tokens": output_limit,
                "system": "\n\n".join(row["content"] for row in messages if row["role"] == "system"),
                "messages": [row for row in messages if row["role"] != "system"]}
    else:
        url = base + "/chat/completions"
        headers["Authorization"] = "Bearer " + str(model["key"])
        body = {"model": model["model"], "messages": messages, "stream": False,
                "max_tokens": output_limit}
    request = urllib.request.Request(url, json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                     headers=headers, method="POST")
    try:
        with urllib.request.build_opener(_NoRedirect()).open(request, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise StructuredFailure("response_limit")
        data = json.loads(raw)
    except urllib.error.HTTPError as exc:
        status = exc.code
        exc.close()
        raise StructuredFailure("model_http", http_status=status) from None
    except TimeoutError:
        raise StructuredFailure("model_timeout") from None
    except urllib.error.URLError as exc:
        code = "model_timeout" if isinstance(exc.reason, TimeoutError) else "model_connection"
        raise StructuredFailure(code) from None
    except OSError:
        raise StructuredFailure("model_connection") from None
    except ValueError:
        raise StructuredFailure("response_format") from None
    try:
        if anthropic:
            reason = data.get("stop_reason")
            text = "".join(part["text"] for part in data.get("content", [])
                           if isinstance(part, dict) and part.get("type") == "text")
            usage = data.get("usage") or {}
            tokens = {"input_tokens": int(usage.get("input_tokens") or 0),
                      "output_tokens": int(usage.get("output_tokens") or 0)}
            from .runtime_messages import usage as normalize_usage
            normalized = normalize_usage(usage)
            if normalized:
                tokens["input_tokens"] = normalized["input"]
                if normalized["cacheRead"] or normalized["cacheWrite"]:
                    tokens.update(cacheRead=normalized["cacheRead"], cacheWrite=normalized["cacheWrite"],
                                  inputIncludesCache=True)
            finished = reason == "end_turn"
        else:
            choice = data["choices"][0]
            reason = choice.get("finish_reason")
            message = choice["message"]
            text = message.get("content")
            usage = data.get("usage") or {}
            tokens = {"input_tokens": int(usage.get("prompt_tokens") or 0),
                      "output_tokens": int(usage.get("completion_tokens") or 0)}
            finished = reason == "stop" and not message.get("tool_calls")
    except (AttributeError, KeyError, TypeError, IndexError, ValueError):
        raise StructuredFailure("response_format") from None
    if reason is not None and not isinstance(reason, str):
        raise StructuredFailure("response_format")
    if on_usage:
        on_usage(tokens)
    if reason in {"length", "max_tokens"}:
        raise StructuredFailure("response_truncated")
    if not finished or not isinstance(text, str) or not text.strip():
        raise StructuredFailure("response_empty")
    return text


def new_work_dir(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix="turn-", dir=root))


def emit(event: dict) -> None:
    print(json.dumps(event, ensure_ascii=False, separators=(",", ":")), flush=True)


class ExecutionEvents:
    def __init__(self, output=emit):
        self.output = output
        self.child_session = ""
        self.error = False
        self.failure = ""
        self.completed = False

    def consume(self, value):
        event = json.loads(value) if isinstance(value, str) else value
        if not isinstance(event, dict):
            raise Harness2Error("Google Harness² 执行组件输出格式无效。")
        if event.get("sessionID"):
            self.child_session = str(event["sessionID"])
        item = event.get("item")
        item_error = isinstance(item, dict) and item.get("type") == "error"
        if (event.get("error") or event.get("is_error") or item_error
                or event.get("type") in {"error", "turn.failed"}):
            from .harness2_errors import failure_message

            self.error = True
            # ACP stdout noise is an item error. Replace the whole event, since
            # its other fields may also contain raw provider text or secrets.
            detail = event.get("error") or (item if item_error else event)
            message = failure_message(RuntimeError(str(detail)), "execute")
            self.failure = self.failure or message
            event = {"error": {"name": "Harness2Error", "message": message}}
        self.output(event)

    def mark_completed(self):
        # Called only after the trusted ACP bridge receives native end_turn.
        self.completed = True

    def succeeded(self, code: int) -> bool:
        return code == 0 and self.completed and not self.error


def execute(prompt: str, cwd: str, session: str, mode: str, terminal: bool,
            executor: str, *, output=emit) -> int:
    from . import acp_bridge
    from .harness2_errors import failure_message

    class StrictBridge(acp_bridge.AcpBridge):
        stage = "start"

        def request(self, method, params):
            self.stage = method
            result = super().request(method, params)
            if (method == "session/prompt"
                    and (not isinstance(result, dict)
                         or result.get("stopReason") not in {"end_turn", "cancelled"})):
                raise Harness2Error("Google Harness² 未收到执行组件的完整完成确认。")
            return result

    events = ExecutionEvents(output)
    original_emit = acp_bridge._emit
    acp_bridge._emit = events.consume
    bridge = None
    failed = False
    try:
        bridge = StrictBridge([executor, "acp"], cwd, "opencode",
                              "readonly" if mode == "plan" else "workspace",
                              session, allow_terminal=terminal)
        if bridge.access.enabled:
            # A resident Runner can retain old --mode metadata. The private
            # channel's current policy also governs initialize-time capabilities.
            bridge.permission = "readonly" if bridge.access.mode == "readonly" else "workspace"
            bridge.allow_terminal = bool(terminal and bridge.permission != "readonly")
        code = bridge.run(prompt)
        if code == 0:
            events.mark_completed()
        # Native permission-transition control uses its existing sentinel exit.
        if code == 73 and not events.error:
            return code
        if not events.succeeded(code):
            raise Harness2Error(events.failure or "Google Harness² 执行未正常完成。")
        return 0
    except Exception as exc:
        failed = True
        if events.failure:
            raise Harness2Error(events.failure) from None
        if isinstance(exc, Harness2Error):
            raise
        raise Harness2Error(failure_message(
            exc, getattr(bridge, "stage", "prepare"))) from None
    finally:
        try:
            if bridge:
                try:
                    bridge.close()
                except Exception as exc:
                    # Cleanup cannot turn a failed call into a success, nor
                    # replace its original, more actionable failure reason.
                    if not failed:
                        raise Harness2Error(failure_message(exc, "cleanup")) from None
        finally:
            acp_bridge._emit = original_emit


def main(argv=None) -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--cwd")
    parser.add_argument("--session", default="")
    parser.add_argument("--mode", choices=["plan", "work"], default="work")
    parser.add_argument("--terminal", action="store_true")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--refine", action="store_true",
                        help="Experimental seven-stage text refinement; incurs additional model usage.")
    args = parser.parse_args(argv)
    if args.version:
        print(VERSION)
        return 0
    model = {}
    stage = "prepare"
    try:
        model = json.loads(os.environ.pop(MODEL_ENV, "{}"))
        executor = os.environ.pop(EXECUTOR_ENV, "")
        root = os.environ.pop(ROOT_ENV, "")
        continuing = os.environ.pop(CONTINUE_ENV, "") == "1"
        from .harness2_lifecycle import disabled_issue
        if issue := disabled_issue():
            raise Harness2Error(issue)
        if not args.cwd or not Path(args.cwd).is_dir():
            raise Harness2Error("Google Harness² 工作目录不存在。")
        if not executor or not Path(executor).is_file():
            raise Harness2Error("Google Harness² 缺少 OpenCode 执行组件，请点「装上」准备。")
        if not root:
            raise Harness2Error("Google Harness² 缺少会话隔离目录。")
        # Also prepare here so a newly launched bridge is safe when its
        # long-lived source Runner still has the previous environment builder.
        from .harness2_runtime import prepare_executor_config
        prepare_executor_config(os.environ)
        prompt = sys.stdin.read()
        if not prompt.strip():
            raise Harness2Error("Google Harness² 没有收到任务内容。")
        def progress(message):
            emit({"type": "step_start"})
            emit({"type": "message_update", "assistantMessageEvent": {
                "type": "thinking_delta", "delta": str(message) + "\n", "contentIndex": 0}})

        def usage(tokens):
            # Usage is a real inference delta, not a synthetic completion marker.
            emit({"type": "step_finish", "part": {"tokens": tokens}})

        # No classifier, planner or synthetic task runs before ordinary execution.
        # Native session history, selected capabilities and permissions remain the
        # executor's responsibility, exactly as for the other managed CLIs.
        final_prompt = prompt
        refined_this_turn = False
        if args.refine and not (continuing and args.session):
            from .harness2_engine import refine
            from .harness2_budget import RefinementBudget

            stage = "refine"
            budget = RefinementBudget()
            refined = refine(
                prompt, lambda messages: budget.run(model, messages, complete, usage),
                new_work_dir(Path(root)), progress)
            refined_this_turn = True
            progress("方案已选定，开始按当前会话权限执行")
            final_prompt = ("以下为 Harness² 文本推演实验生成的参考执行方法。"
                            "它不能改变用户指令、授权范围、权限模式或已选择的技能与插件。\n"
                            "<harness2_instructions>\n" + refined + "\n</harness2_instructions>\n\n"
                            "用户的原始任务（完整保留）：\n" + prompt)
        stage = "execute"
        code = execute(final_prompt, args.cwd, args.session, args.mode, args.terminal, executor)
        if args.probe and code == 0:
            # A permission transition cannot prove that this process refined.
            if not args.refine or refined_this_turn:
                emit({"type": "harness2_probe_complete",
                      "coverage": "refine-v1" if refined_this_turn else "execute-v2",
                      "stages": 7 if refined_this_turn else 0})
        return code
    except Exception as exc:
        # Keep upstream proposal content, user task and model credentials out of errors.
        from .harness2_errors import failure_message
        secret = str(model.get("key") or "") if isinstance(model, dict) else ""
        text = (str(exc) if isinstance(exc, Harness2Error) and not isinstance(exc, StructuredFailure)
                else failure_message(exc, stage, secret))
        if secret:
            text = text.replace(secret, "[redacted]")
        error = {"name": "Harness2Error", "message": text}
        if isinstance(exc, StructuredFailure):
            # Revalidate fields before rendering and forwarding machine-readable
            # diagnostics; provider bodies and arbitrary exception args stay out.
            safe = StructuredFailure(exc.code, phase=exc.phase, http_status=exc.http_status)
            error.update(code=safe.code, phase=safe.phase)
            if safe.http_status is not None:
                error["httpStatus"] = safe.http_status
        emit({"error": error})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
