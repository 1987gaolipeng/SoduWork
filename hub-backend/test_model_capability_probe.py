"""Bounded protocol regressions with synthetic responses and no external inference."""
import asyncio
import json
import re
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.services import model_capabilities as caps, model_capability_probe as probe
from app.services.model_errors import UpstreamError


CONF = {"base": "https://fixture.invalid/v1", "key": "synthetic", "model": "opaque",
        "kind": "openai-compat", "config": {"maxOutputTokens": 4096}}


class Response:
    def __init__(self, data, *, content_type="application/json", chunks=None):
        self.data = data if isinstance(data, bytes) else json.dumps(data).encode()
        self.parts = chunks if chunks is not None else [self.data]
        self.headers = {"content-type": content_type}
        self.closed = False

    async def read(self, cap):
        if len(self.data) > cap:
            raise ValueError("bounded fixture read")
        return self.data

    async def chunks(self):
        for part in self.parts:
            yield part

    async def aclose(self):
        self.closed = True


def message(content="OK", **extra):
    return Response({"choices": [{"finish_reason": "stop", "message": {"content": content, **extra}}]})


def stream_message(content="OK", *, finish="stop", **extra):
    raw = ("data: " + json.dumps({"choices": [{"index": 0, "delta": {"content": content, **extra},
        "finish_reason": finish}]}) + "\n\ndata: [DONE]\n\n").encode()
    return Response(raw, content_type="text/event-stream")


def receipt(body):
    return next(part["content"] for part in body["messages"] if part["role"] == "tool")


def has_tool_result(body):
    return any(part["role"] == "tool" for part in body["messages"])


def streamed_tool(value, *, name="soduwork_capability_echo", arguments=None, extra=False,
                  finish="tool_calls", done=True, error=False, reasoning=False):
    arguments = json.dumps({"value": value}) if arguments is None else arguments
    encoded = lambda delta, reason=None: "data: " + json.dumps({"choices": [
        {"index": 0, "delta": delta, "finish_reason": reason}]}) + "\r\n\r\n"
    split = len(arguments) // 2
    data = ": heartbeat\r\n\r\n"
    if reasoning:
        data += encoded({"reasoning_content": "synthetic thought"})
    data += encoded({"tool_calls": [{"index": 0, "id": "call-", "type": "function", "function": {
        "name": name[:8], "arguments": arguments[:split]}}]})
    data += encoded({"tool_calls": [{"index": 0, "id": "fixture", "function": {
        "name": name[8:], "arguments": arguments[split:]}}]})
    if extra:
        data += encoded({"tool_calls": [{"index": 1, "id": "other-call", "type": "function", "function": {
            "name": name, "arguments": json.dumps({"value": value})}}]})
    if finish is not None:
        data += encoded({}, finish)
    if error:
        data += 'event: error\r\ndata: {"error":{"message":"private fixture error"}}\r\n\r\n'
    if done:
        data += "data: [DONE]\r\n\r\n"
    raw = data.encode()
    return Response(raw, content_type="text/event-stream", chunks=[raw[index:index + 3] for index in range(0, len(raw), 3)])


class ProbeTests(unittest.IsolatedAsyncioTestCase):
    async def test_check_durations_include_transport_reads_tool_round_trip_and_cleanup(self):
        clock = [1000.0]

        def handler(body):
            clock[0] += 0.013
            if has_tool_result(body):
                response = stream_message(receipt(body))
            elif body.get("tools"):
                value = re.search(r"value ([a-f0-9]{16})", body["messages"][0]["content"])[1]
                response = streamed_tool(value)
            else:
                response = stream_message() if body.get("stream") else message()
            chunks, close = response.chunks, response.aclose

            async def read():
                clock[0] += 0.017
                async for part in chunks():
                    yield part

            async def closed():
                clock[0] += 0.019
                await close()

            response.chunks, response.aclose = read, closed
            return response

        with patch.object(probe, "time", SimpleNamespace(monotonic=lambda: clock[0])):
            result = await self.run_probe(["connection", "toolCalling", "toolCalling", "streaming"], handler)
        self.assertEqual(len(self.requests), 4)
        self.assertEqual({key: value["durationMs"] for key, value in result["checks"].items()},
                         {"connection": 49.0, "toolCalling": 98.0, "streaming": 49.0})
        self.assertTrue(all(check["status"] == "passed" for check in result["checks"].values()))
        self.assertEqual(result["checks"]["toolCalling"]["stage"], "tool_result")

    async def test_failed_and_inconclusive_attempts_keep_their_own_elapsed_time(self):
        for error, status, code in ((UpstreamError(401, '{"error":{"message":"synthetic refusal"}}'),
                                    "failed", "credentials_or_access"),
                                   (TimeoutError(), "inconclusive", "timeout"),
                                   (ValueError("synthetic invalid response"), "inconclusive", "invalid_response")):
            with self.subTest(code=code):
                clock = [1000.0]

                def handler(body):
                    clock[0] += 0.025
                    raise error

                with patch.object(probe, "time", SimpleNamespace(monotonic=lambda: clock[0])):
                    report = await self.run_probe(["connection", "streaming"], handler)
                for check in report["checks"].values():
                    self.assertEqual((check["status"], check["code"], check["durationMs"]), (status, code, 25.0))
                self.assertFalse(report["reasoningStreamReported"])

    async def test_duration_includes_compatibility_retry_without_timing_an_untested_protocol(self):
        clock = [1000.0]

        def handler(body):
            clock[0] += 0.020
            if "max_tokens" in body:
                raise UpstreamError(400, '{"error":{"code":"unsupported_parameter","param":"max_tokens"}}')
            return message()

        with patch.object(probe, "time", SimpleNamespace(monotonic=lambda: clock[0])):
            report = await self.run_probe(["connection"], handler)
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(report["checks"]["connection"]["durationMs"], 40.0)
        self.assertEqual(report["checks"]["connection"]["status"], "passed")
        self.assertEqual(report["compatibility"]["maxTokensField"], "max_completion_tokens")
        report = await self.run_probe(["connection"], handler, {**CONF, "kind": "anthropic"})
        self.assertEqual(self.requests, [])
        self.assertEqual(report["checks"]["connection"]["code"], "protocol_not_tested")
        self.assertNotIn("durationMs", report["checks"]["connection"])

    async def test_plain_tools_retry_requires_a_matching_receipt_and_keeps_controls_out(self):
        for outcome, status in (("valid", "passed"), ("wrong receipt", "inconclusive"),
                                ("refused", "unsupported")):
            with self.subTest(outcome=outcome):
                def handler(body):
                    if body.get("stream") or outcome == "refused":
                        raise UpstreamError(422, '{"error":{"code":"unsupported_tools"}}')
                    self.assertEqual(set(body), {"model", "messages", "tools"})
                    if has_tool_result(body):
                        assistant = body["messages"][-2]
                        self.assertEqual(assistant["reasoning_content"], "fixture reasoning")
                        self.assertNotIn("index", assistant["tool_calls"][0])
                        self.assertEqual(body["messages"][-1]["tool_call_id"], "call-json")
                        return message(receipt(body) if outcome == "valid" else "wrong")
                    value = re.search(r"value ([a-f0-9]{16})", body["messages"][0]["content"])[1]
                    call = {"index": 0, "id": "call-json", "type": "function", "function": {
                        "name": "soduwork_capability_echo", "arguments": json.dumps({"value": value})}}
                    return Response({"choices": [{"finish_reason": "tool_calls", "message": {
                        "role": "assistant", "content": None, "reasoning_content": "fixture reasoning",
                        "tool_calls": [call]}}]})

                result = await self.run_probe(["toolCalling"], handler, {
                    **CONF, "thinkingMode": "always", "thinkingFormat": "deepseek"})
                self.assertEqual(result["checks"]["toolCalling"]["status"], status)
                self.assertEqual(len(self.requests), 2 if outcome == "refused" else 3)
                self.assertEqual(result["compatibility"], {})
                self.assertFalse(result["reasoningStreamReported"])

    async def run_probe(self, checks, handler, conf=None):
        self.requests, self.responses = [], []
        async def opened(target, path, encoded, **kwargs):
            body = json.loads(encoded)
            self.requests.append(body)
            response = handler(body)
            if asyncio.iscoroutine(response):
                response = await response
            self.responses.append(response)
            return response
        with patch.object(probe.model_transport, "open_response", side_effect=opened):
            result = await probe.run(conf or CONF, checks)
        self.assertTrue(all(response.closed for response in self.responses))
        return result

    async def test_streaming_receipt_rejection_and_truncation_do_not_pass(self):
        for mode in ("rejected", "truncated", "valid"):
            def handler(body):
                if has_tool_result(body):
                    self.assertTrue(body["stream"])
                    self.assertEqual(body["messages"][-1]["role"], "tool")
                    self.assertEqual(body["tools"], self.requests[0]["tools"])
                    self.assertNotIn("tool_choice", body)
                    if mode == "rejected":
                        raise UpstreamError(403, '{"error":{"message":"synthetic refusal"}}')
                    if mode == "truncated":
                        raw = ("data: " + json.dumps({"choices": [{"index": 0, "delta": {"content": receipt(body)},
                            "finish_reason": None}]}) + "\n\n").encode()
                        return Response(raw, content_type="text/event-stream")
                    return stream_message(receipt(body))
                return streamed_tool(re.search(r"value ([a-f0-9]{16})", body["messages"][0]["content"])[1])
            report = await self.run_probe(["toolCalling"], handler, {**CONF, "compatibility": {"toolChoice": "named"}})
            self.assertEqual(report["checks"]["toolCalling"]["stage"], "tool_result")
            self.assertEqual(report["checks"]["toolCalling"]["status"] == "passed", mode == "valid")

    async def test_v2_success_is_retired_on_projection_and_partial_merge(self):
        old = {"reportVersion": 2, "configRevision": "same", "checks": {
            key: {"status": "passed"} for key in caps.CHECKS}}
        old["verifiedChecks"] = dict(old["checks"])
        for result in (old, caps.merge_evidence(old, {"reportVersion": 3, "configRevision": "same",
                "checks": {"connection": {"status": "passed"}}})):
            profile = caps.runtime_fields({}, result)["capabilityProfile"]
            self.assertEqual(profile["toolCalling"]["state"], "unknown")
            self.assertEqual(profile["streaming"]["state"], "supported")
            self.assertEqual(profile["imageInput"]["state"], "supported")

    async def test_shared_probe_protocol_vectors_and_exact_safe_tool_policy(self):
        fixture = Path(__file__).resolve().parents[1] / "tools/contracts/model-capability-probe-v1.json"
        contract = json.loads(fixture.read_text(encoding="utf-8"))
        policy = contract["policy"]
        for case in contract["cases"]:
            with self.subTest(case["name"]):
                def handler(body):
                    if has_tool_result(body):
                        self.assertIs(body["stream"], policy["followupStream"])
                        self.assertEqual(body["tools"], [policy["tool"]])
                        self.assertNotIn("tool_choice", body)
                        self.assertEqual(body["messages"][-1]["role"], "tool")
                        self.assertRegex(receipt(body), r"^[a-f0-9]{16}$")
                        if "replayedReasoning" in case:
                            self.assertEqual(body["messages"][-2]["reasoning_content"], case["replayedReasoning"])
                        final = json.dumps(case["followup"]).replace("{{receipt}}", receipt(body))
                        choice = json.loads(final)["choices"][0]
                        return stream_message(finish=choice["finish_reason"], **choice["message"])
                    if case["check"] == "toolCalling":
                        self.assertEqual(body["tools"], [policy["tool"]])
                        self.assertEqual(body["tool_choice"], policy["toolChoice"])
                        nonce = re.search(r"value ([a-f0-9]{16})", body["messages"][0]["content"])[1]
                        self.assertEqual(body["messages"][0]["content"], policy["toolPrompt"].replace("{{value}}", nonce))
                        if case.get("requireAuto") and body["tool_choice"] != "auto":
                            return Response(b'data: {"choices":[{"delta":{"content":"text"},"finish_reason":"stop"}]}\n\n',
                                            content_type="text/event-stream")
                    else:
                        nonce = ""
                    raw = "".join(case["initialChunks"]).replace("{{value}}", nonce).encode()
                    size = case.get("byteChunkSize", len(raw) or 1)
                    return Response(raw, content_type="text/event-stream",
                                    chunks=[raw[index:index + size] for index in range(0, len(raw), size)])
                result = await self.run_probe([case["check"]], handler)
                check = result["checks"][case["check"]]
                for key, expected in case["expect"].items():
                    self.assertEqual(len(self.requests) if key == "requestCount" else check.get(key), expected, result)
                if check["status"] == "passed":
                    self.assertNotIn("detailCode", check)
                self.assertNotIn("synthetic private response", json.dumps(result))

    async def test_shared_probe_resource_limits(self):
        fixture = Path(__file__).resolve().parents[1] / "tools/contracts/model-capability-probe-v1.json"
        policy = json.loads(fixture.read_text(encoding="utf-8"))["policy"]
        self.assertEqual((probe.MAX_CALLS, probe.MAX_NEGOTIATIONS), (policy["maxRequests"], policy["maxNegotiations"]))
        self.assertEqual((probe.TIMEOUT * 1000, probe.TOTAL_TIMEOUT * 1000, probe.MAX_BYTES),
                         (policy["timeoutMs"], policy["totalMs"], policy["maxResponseBytes"]))

    async def test_shared_probe_failure_classification_vectors(self):
        fixture = Path(__file__).resolve().parents[1] / "tools/contracts/model-capability-probe-v1.json"
        for case in json.loads(fixture.read_text(encoding="utf-8"))["failureCases"]:
            with self.subTest(case["name"]):
                error = UpstreamError(case["status"], json.dumps({"error": case["error"]}))
                self.assertEqual(probe._failure(error, case["check"]),
                                 (case["expect"]["status"], case["expect"]["code"]))

    async def test_shared_connection_image_and_stream_output_vectors(self):
        fixture = Path(__file__).resolve().parents[1] / "tools/contracts/model-capability-probe-v1.json"
        cases = json.loads(fixture.read_text(encoding="utf-8"))["outputCases"]
        with patch.object(probe, "image_challenge", return_value=("582941", "data:image/png;base64,fixture")):
            for case in cases:
                with self.subTest(case["name"]):
                    def handler(body):
                        if "initialResponse" in case:
                            return Response(case["initialResponse"])
                        chunks = [part.encode() for part in case["initialChunks"]]
                        return Response(b"".join(chunks), content_type="text/event-stream", chunks=chunks)
                    result = await self.run_probe([case["check"]], handler)
                    actual = result["checks"][case["check"]]
                    for key, expected in case["expect"].items():
                        self.assertEqual(len(self.requests) if key == "requestCount" else actual.get(key), expected, result)

    async def test_general_checks_require_an_explicit_successful_finish_reason(self):
        with patch.object(probe, "image_challenge", return_value=("582941", "data:image/png;base64,fixture")):
            for check, content in (("connection", "OK"), ("imageInput", "582941")):
                with self.subTest(check=check):
                    result = await self.run_probe([check], lambda body: Response({"choices": [{"message": {"content": content}}]}))
                    actual = result["checks"][check]
                    self.assertEqual((actual["status"], actual["code"]), ("inconclusive", "invalid_response"))
        raw = b'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\ndata: [DONE]\n\n'
        result = await self.run_probe(["streaming"], lambda body: Response(raw, content_type="text/event-stream"))
        actual = result["checks"]["streaming"]
        self.assertEqual((actual["status"], actual["code"]), ("inconclusive", "invalid_response"))

    async def test_usage_only_metadata_is_validated_even_after_meaningful_output(self):
        prefix = b'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n'
        valid = [{"usage": {"total_tokens": 0}}, {"usage": {"total_tokens": 1.0}},
                 {"choices": [], "object": "chat.completion.chunk", "created": 0, "model": "fixture",
                  "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3,
                            "completion_tokens_details": {"reasoning_tokens": 0, "audio_tokens": None}}}]
        invalid = [{}, {"choices": []}, {"usage": {}}, {"usage": []}, {"usage": {"total_tokens": True}},
                   {"usage": {"total_tokens": -1}}, {"usage": {"total_tokens": 1.5}},
                   {"usage": {"total_tokens": "1"}}, {"usage": {"total_tokens": 1, "message": "private"}},
                   {"usage": {"total_tokens": 2 ** 53}},
                   {"usage": {"total_tokens": 1, "completion_tokens_details": {"reasoning_tokens": -1}}},
                   {"usage": {"total_tokens": 1}, "type": "metadata"},
                   {"usage": {"total_tokens": 1}, "unrecognized": True},
                   {"usage": {"total_tokens": 1}, "object": {}},
                   {"usage": {"total_tokens": 1}, "created": False}]
        for passes, metadata in [(True, value) for value in valid] + [(False, value) for value in invalid]:
            with self.subTest(metadata=metadata):
                raw = prefix + ("data: " + json.dumps(metadata) + "\n\n").encode() + b'data: [DONE]\n\n'
                result = await self.run_probe(["streaming"], lambda body: Response(raw, content_type="text/event-stream"))
                actual = result["checks"]["streaming"]
                self.assertEqual(actual["status"], "passed" if passes else "inconclusive")
                if not passes:
                    self.assertEqual(actual.get("detailCode"), "invalid_stream_shape")

    async def test_malformed_choices_deltas_and_duplicate_finishes_never_pass(self):
        first = {"choices": [{"delta": {"content": "OK"}, "finish_reason": "stop"}]}
        malformed = [{"choices": [{"index": False, "delta": {"content": "OK"}, "finish_reason": "stop"}]},
                     *({"choices": [{"delta": value, "finish_reason": "stop"}]} for value in (None, False, [], "", 0)),
                     *({"choices": [{"delta": {key: []}, "finish_reason": "stop"}]}
                       for key in ("content", "reasoning_content", "reasoning", "thinking")),
                     {"choices": [{"delta": {"role": "user", "content": "OK"}, "finish_reason": "stop"}]},
                     {"choices": [{"delta": {"tool_calls": False, "content": "OK"}, "finish_reason": "stop"}]},
                     {"choices": [{"delta": {"tool_calls": [{"function": False}]}, "finish_reason": "stop"}]}]
        for value in malformed:
            with self.subTest(value=value):
                raw = ("data: " + json.dumps(value) + "\n\ndata: [DONE]\n\n").encode()
                result = await self.run_probe(["streaming"], lambda body: Response(raw, content_type="text/event-stream"))
                self.assertEqual(result["checks"]["streaming"]["status"], "inconclusive")
                self.assertEqual(result["checks"]["streaming"].get("detailCode"), "invalid_stream_shape")
        raw = ("data: " + json.dumps(first) + "\n\ndata: " + json.dumps(first) + "\n\n").encode()
        result = await self.run_probe(["streaming"], lambda body: Response(raw, content_type="text/event-stream"))
        self.assertEqual(result["checks"]["streaming"].get("detailCode"), "invalid_stream_shape")

    async def test_integer_valued_json_numbers_match_the_shared_wire_policy(self):
        def handler(body):
            if has_tool_result(body):
                return Response(stream_message(receipt(body)).data.replace(b'"index": 0', b'"index": 0.0'), content_type="text/event-stream")
            nonce = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
            raw = streamed_tool(nonce).data.replace(b'"index": 0', b'"index": 0.0')
            return Response(raw, content_type="text/event-stream")
        result = await self.run_probe(["toolCalling"], handler)
        self.assertEqual(result["checks"]["toolCalling"]["status"], "passed")

    async def test_heartbeat_type_error_and_unknown_named_event_cannot_hide_errors(self):
        prefix = b'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n'
        for extra in (b'event: heartbeat\ndata: {"type":"error","message":"private"}\n\n',
                      b'event: unrecognized\ndata: {"usage":{"total_tokens":1}}\n\n'):
            raw = prefix + extra
            result = await self.run_probe(["streaming"], lambda body: Response(raw, content_type="text/event-stream"))
            self.assertEqual(result["checks"]["streaming"]["status"], "inconclusive")

    async def test_harmless_provider_extensions_on_model_deltas_preserve_evidence(self):
        raw = b'data: {"vendor_meta":{},"choices":[{"vendor_choice":true,"delta":{"vendor_delta":1,"content":"OK"},"finish_reason":"stop"}]}\n\n'
        result = await self.run_probe(["streaming"], lambda body: Response(raw, content_type="text/event-stream"))
        self.assertEqual(result["checks"]["streaming"]["status"], "passed")
        def handler(body):
            if has_tool_result(body):
                return stream_message(receipt(body))
            value = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
            raw = streamed_tool(value).data.replace(b'"id": "call-"', b'"vendor_call": 1, "id": "call-"')
            raw = raw.replace(b'"name": "soduwork"', b'"vendor_function": 1, "name": "soduwork"')
            return Response(raw, content_type="text/event-stream")
        result = await self.run_probe(["toolCalling"], handler)
        self.assertEqual(result["checks"]["toolCalling"]["status"], "passed")

    async def test_meaningless_output_has_safe_expected_output_detail(self):
        result = await self.run_probe(["connection"], lambda body: message("  "))
        self.assertEqual(result["checks"]["connection"].get("detailCode"), "expected_output_mismatch")
        raw = b'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":"stop"}]}\n\n'
        result = await self.run_probe(["streaming"], lambda body: Response(raw, content_type="text/event-stream"))
        self.assertEqual(result["checks"]["streaming"].get("detailCode"), "expected_output_mismatch")

    async def test_optional_control_parameter_cannot_become_capability_unsupported(self):
        for param in ("max_tokens", "max_completion_tokens", "tool_choice", "stream_options"):
            error = UpstreamError(400, json.dumps({"error": {"code": "unsupported_tools", "param": param}}))
            self.assertEqual(probe._failure(error, "toolCalling"), ("inconclusive", "parameter_not_supported"))

    async def test_known_nested_field_types_cannot_be_hidden_by_valid_text(self):
        choices = [{"delta": {"content": "OK"}, "finish_reason": "stop", "logprobs": False},
                   {"delta": {"content": "OK", "function_call": False}, "finish_reason": "stop"}]
        for choice in choices:
            with self.subTest(streamed_choice=choice):
                raw = ("data: " + json.dumps({"choices": [choice]}) + "\n\n").encode()
                result = await self.run_probe(["streaming"], lambda body: Response(raw, content_type="text/event-stream"))
                self.assertEqual(result["checks"]["streaming"]["status"], "inconclusive")
                self.assertEqual(result["checks"]["streaming"].get("detailCode"), "invalid_stream_shape")
        messages = [{"content": "OK", "tool_calls": [None]},
                    {"content": "OK", "tool_calls": [{"id": None}]},
                    {"content": "OK", "tool_calls": [{"function": False}]},
                    {"content": "OK", "tool_calls": [{"function": {"arguments": []}}]},
                    {"content": "OK", "function_call": False}]
        for value in messages:
            with self.subTest(message=value):
                result = await self.run_probe(["connection"], lambda body: Response({"choices": [{"message": value}]}))
                self.assertEqual(result["checks"]["connection"]["status"], "inconclusive")

    async def test_connection_and_streaming_accept_meaningful_text_or_reasoning_only(self):
        for field in ("content", "reasoning_content", "reasoning", "thinking"):
            for value in ("READY", "  ", None):
                with self.subTest(field=field, value=value):
                    result = await self.run_probe(["connection"], lambda body: message(None, **{field: value})
                                                  if field != "content" else message(value))
                    self.assertEqual(result["checks"]["connection"]["status"], "passed" if value == "READY" else "inconclusive")
        result = await self.run_probe(["streaming"], lambda body: streamed_tool("0123456789abcdef"))
        self.assertEqual(result["checks"]["streaming"]["status"], "inconclusive")

    async def test_image_requires_only_the_exact_trimmed_six_digits(self):
        with patch.object(probe, "image_challenge", return_value=("123456", "data:image/png;base64,fixture")):
            for value in ("123456", " \n123456\t", "Digits: 123456", "123 456", "123456.", "654321"):
                with self.subTest(value=value):
                    result = await self.run_probe(["imageInput"], lambda body: message(value))
                    actual = result["checks"]["imageInput"]
                    self.assertEqual(actual["status"], "passed" if value.strip() == "123456" else "inconclusive")
                    self.assertEqual(actual.get("stage"), "output")
                    if value.strip() != "123456":
                        self.assertEqual(actual.get("detailCode"), "expected_output_mismatch")

    async def test_reasoning_model_truncated_probe_retries_with_larger_budget(self):
        # A reasoning model can spend the small fixed probe budget on its thinking
        # trail and get cut off before the short deterministic answer. The image
        # challenge must still be verifiable with one bounded higher-budget retry.
        with patch.object(probe, "image_challenge", return_value=("582941", "data:image/png;base64,fixture")):
            calls = []
            def handler(body):
                calls.append(body)
                if len(calls) == 1:
                    # First probe exhausts the small budget on reasoning; no final answer.
                    return Response({"choices": [{"finish_reason": "length", "message": {
                        "content": "", "reasoning_content": "thinking " * 200}}]})
                # Retry with a larger budget returns the expected six digits.
                return message("582941")
            result = await self.run_probe(["imageInput"], handler)
        actual = result["checks"]["imageInput"]
        self.assertEqual(actual["status"], "passed", result)
        self.assertEqual(len(self.requests), 2)
        first = self.requests[0].get("max_tokens", self.requests[0].get("max_completion_tokens"))
        second = self.requests[1].get("max_tokens", self.requests[1].get("max_completion_tokens"))
        self.assertGreater(second, first)

    async def test_reasoning_retry_respects_both_saved_limits_and_retries_only_once(self):
        for finish, output, context, budgets in (
            ("length", 1024, 4096, [512, 1024]),
            ("max_tokens", 4096, 768, [512, 768]),
            ("max_output_tokens", 4096, 8192, [512, 4096]),
            ("length", 512, 4096, [512]),
        ):
            with self.subTest(finish=finish, output=output, context=context):
                conf = {**CONF, "config": {"maxOutputTokens": output, "contextWindow": context},
                        "compatibility": {"maxTokensField": "max_completion_tokens"}}
                choice = {"finish_reason": finish, "message": {"reasoning": "still working"}}
                result = await self.run_probe(["connection"], lambda _: Response({"choices": [choice]}), conf)
                self.assertEqual(result["checks"]["connection"]["code"], "response_truncated")
                self.assertEqual([body["max_completion_tokens"] for body in self.requests], budgets)

    async def test_only_complete_valid_reasoning_responses_trigger_a_retry(self):
        choice = {"finish_reason": "length", "message": {"reasoning_content": "still working"}}
        for data, outcome, expected in (
            ({"choices": [choice]}, "timeout", "timeout"),
            ({"choices": [choice]}, "interrupted", "transport_interrupted"),
            ({"choices": [choice, choice]}, "completed", "invalid_response"),
            ({"choices": [{**choice, "message": {"role": "user", "thinking": "text"}}]}, "completed", "invalid_response"),
            ({"choices": [{**choice, "message": {"content": "partial"}}]}, "completed", "response_truncated"),
        ):
            with self.subTest(outcome=outcome, expected=expected):
                response = Response(data)
                response.outcome = outcome
                result = await self.run_probe(["connection"], lambda _: response)
                self.assertEqual(result["checks"]["connection"]["code"], expected)
                self.assertEqual(len(self.requests), 1)

    async def test_nonstream_malformed_bodies_cannot_verify_connection(self):
        malformed = [{"choices": [{"message": {"content": "OK"}}, {"message": {"content": "ignored"}}]},
                     {"choices": [{"index": False, "message": {"content": "OK"}}]},
                     {"choices": [{"message": {"role": "user", "content": "OK"}}]},
                     {"choices": [{"message": {"content": "OK", "reasoning_content": []}}]},
                     {"choices": [{"message": {"content": "OK"}, "finish_reason": "unknown"}]},
                     {"choices": [{"message": {"content": "OK"}, "finish_reason": "content_filter"}]},
                     {"choices": [{"message": {"content": "OK"}}], "type": "error"}]
        for value in malformed:
            with self.subTest(value=value):
                result = await self.run_probe(["connection"], lambda body: Response(value))
                self.assertEqual(result["checks"]["connection"]["status"], "inconclusive")

    async def test_actual_http_attempt_limit_counts_parameter_retries(self):
        def handler(body):
            if "max_tokens" in body:
                raise UpstreamError(400, '{"error":{"code":"unsupported_parameter","param":"max_tokens"}}')
            return message()
        with patch.object(probe, "MAX_CALLS", 1):
            result = await self.run_probe(["connection"], handler)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(result["checks"]["connection"]["code"], "budget_exhausted")
        self.assertNotIn("maxTokensField", result["compatibility"])

    async def test_already_auto_refusal_does_not_consume_negotiation(self):
        budget = probe._Budget()
        error = UpstreamError(400, '{"error":{"code":"unsupported_parameter","param":"tool_choice"}}')
        self.assertFalse(budget.negotiate(error, {"tool_choice": "auto"}))
        self.assertEqual((budget.negotiations, budget.variants), (0, set()))

    async def test_negotiated_output_field_survives_transient_failure_for_later_checks(self):
        def handler(body):
            if "max_tokens" in body:
                raise UpstreamError(400, '{"error":{"code":"unsupported_parameter","param":"max_tokens"}}')
            if not body["stream"]:
                raise UpstreamError(503, '{"error":{"message":"synthetic temporary failure"}}')
            return Response(b'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
                            content_type="text/event-stream")
        failed = await self.run_probe(["connection"], handler)
        self.assertNotIn("maxTokensField", failed["compatibility"])
        result = await self.run_probe(["connection", "streaming"], handler)
        self.assertEqual(result["checks"]["connection"]["code"], "temporarily_unavailable")
        self.assertEqual(result["checks"]["streaming"]["status"], "passed")
        self.assertEqual(["max_completion_tokens" if "max_completion_tokens" in body else "max_tokens"
                          for body in self.requests], ["max_tokens", "max_completion_tokens", "max_completion_tokens"])
        self.assertEqual(result["compatibility"]["maxTokensField"], "max_completion_tokens")

    async def test_negotiated_stream_options_survive_transient_failure_for_later_checks(self):
        def handler(body):
            if "stream_options" in body:
                raise UpstreamError(400, '{"error":{"code":"unsupported_parameter","param":"stream_options"}}')
            if has_tool_result(body):
                return stream_message(receipt(body))
            if body.get("tools"):
                value = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
                return streamed_tool(value)
            raise UpstreamError(503, '{"error":{"message":"synthetic temporary failure"}}')
        failed = await self.run_probe(["streaming"], handler)
        self.assertNotIn("streamOptions", failed["compatibility"])
        result = await self.run_probe(["streaming", "toolCalling"], handler)
        self.assertEqual(result["checks"]["streaming"]["code"], "temporarily_unavailable")
        self.assertEqual(result["checks"]["toolCalling"]["status"], "passed")
        self.assertEqual(["stream_options" in body for body in self.requests], [True, False, False, False])
        self.assertIs(result["compatibility"]["streamOptions"], False)

    async def test_cancellation_propagates_and_closes_response_without_followup(self):
        opened = asyncio.Event()
        class CancelResponse(Response):
            async def chunks(self):
                yield self.data
                opened.set()
                await asyncio.Event().wait()
        response = CancelResponse(streamed_tool("0123456789abcdef").data, content_type="text/event-stream")
        async def request(*args, **kwargs):
            return response
        with patch.object(probe.model_transport, "open_response", side_effect=request):
            task = asyncio.create_task(probe.run(CONF, ["toolCalling"]))
            await opened.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertTrue(response.closed)

    async def test_tool_choice_rejection_negotiates_auto_and_confirms_synthetic_result(self):
        def handler(body):
            if isinstance(body.get("tool_choice"), dict):
                raise UpstreamError(400, json.dumps({"error": {"code": "unsupported_parameter",
                    "param": "tool_choice", "message": "named tool_choice is not supported"}}))
            if has_tool_result(body):
                return stream_message(receipt(body))
            value = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
            return streamed_tool(value)
        result = await self.run_probe(["toolCalling"], handler, {**CONF, "compatibility": {"toolChoice": "named"}})
        self.assertEqual(result["checks"]["toolCalling"]["status"], "passed")
        self.assertEqual(result["compatibility"]["toolChoice"], "auto")
        self.assertEqual(len(self.requests), 3)
        self.assertEqual(self.requests[-1]["messages"][-1]["role"], "tool")
        self.assertEqual(result["reportVersion"], 3)
        self.assertEqual(result["apiFamily"], "chat-completions")

    async def test_cached_named_plain_stop_text_retries_auto_and_confirms_only_the_safe_receipt(self):
        def handler(body):
            if has_tool_result(body):
                return stream_message(receipt(body))
            if isinstance(body.get("tool_choice"), dict):
                return Response(b'data: {"choices":[{"delta":{"content":"Use automatic tool selection."},"finish_reason":"stop"}]}\n\n',
                                content_type="text/event-stream")
            value = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
            return streamed_tool(value)
        conf = {**CONF, "compatibility": {"toolChoice": "named"}}
        result = await self.run_probe(["toolCalling"], handler, conf)
        self.assertEqual(result["checks"]["toolCalling"]["status"], "passed")
        self.assertEqual(result["compatibility"]["toolChoice"], "auto")
        self.assertEqual(len(self.requests), 3)
        self.assertIsInstance(self.requests[0]["tool_choice"], dict)
        self.assertEqual(self.requests[1]["tool_choice"], "auto")
        self.assertEqual(self.requests[0]["messages"], self.requests[1]["messages"])
        self.assertEqual(self.requests[2]["tools"], self.requests[1]["tools"])

    async def test_ambiguous_text_never_confirms_a_tool_choice_or_retries_auto_again(self):
        plain = b'data: {"choices":[{"delta":{"content":"ordinary text"},"finish_reason":"stop"}]}\n\n'
        for previous, count in (({"toolChoice": "named", "streamOptions": False, "maxTokensField": "max_completion_tokens"}, 2), ({}, 1)):
            with self.subTest(previous=previous):
                result = await self.run_probe(["toolCalling"], lambda body: Response(plain, content_type="text/event-stream"),
                                              {**CONF, "compatibility": previous})
                self.assertEqual(result["checks"]["toolCalling"]["detailCode"], "tool_call_count_mismatch")
                self.assertEqual(len(self.requests), count)
                self.assertEqual(result["compatibility"].get("toolChoice"), previous.get("toolChoice"))
                for key, value in previous.items():
                    self.assertEqual(result["compatibility"][key], value)

    async def test_failed_receipt_preserves_confirmed_tool_choice_after_text_or_http_fallback(self):
        previous = {"toolChoice": "named", "streamOptions": False, "maxTokensField": "max_completion_tokens"}
        for rejection in ("text", "http"):
            with self.subTest(rejection=rejection):
                def handler(body):
                    if has_tool_result(body):
                        return stream_message("unrelated receipt")
                    if isinstance(body.get("tool_choice"), dict):
                        if rejection == "http":
                            raise UpstreamError(400, '{"error":{"code":"unsupported_parameter","param":"tool_choice"}}')
                        return Response(b'data: {"choices":[{"delta":{"content":"ordinary text"},"finish_reason":"stop"}]}\n\n',
                                        content_type="text/event-stream")
                    value = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
                    return streamed_tool(value)
                result = await self.run_probe(["toolCalling"], handler, {**CONF, "compatibility": previous})
                self.assertEqual(result["checks"]["toolCalling"]["detailCode"], "tool_receipt_mismatch")
                self.assertEqual(result["compatibility"], previous)
                self.assertEqual(len(self.requests), 3)

    async def test_named_partial_wrong_or_legacy_calls_never_trigger_text_fallback(self):
        for kind in ("partial", "wrong", "legacy"):
            with self.subTest(kind=kind):
                def handler(body):
                    value = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
                    if kind == "legacy":
                        delta = {"content": "ordinary text", "function_call": {"name": "other", "arguments": "{}"}}
                        data = ("data: " + json.dumps({"choices": [{"delta": delta, "finish_reason": "stop"}]}) + "\n\n").encode()
                    else:
                        options = {"arguments": '{"value":'} if kind == "partial" else {"name": "other"}
                        data = streamed_tool(value, finish="stop", **options).data
                    return Response(data, content_type="text/event-stream")
                result = await self.run_probe(["toolCalling"], handler, {**CONF, "compatibility": {"toolChoice": "named"}})
                self.assertEqual(result["checks"]["toolCalling"]["status"], "inconclusive")
                self.assertEqual(len(self.requests), 1)
                self.assertEqual(result["compatibility"]["toolChoice"], "named")

    async def test_named_text_repair_obeys_the_shared_seven_request_and_two_negotiation_limits(self):
        def handler(body):
            if "max_tokens" in body:
                raise UpstreamError(400, '{"error":{"code":"unsupported_parameter","param":"max_tokens"}}')
            if has_tool_result(body):
                return stream_message(receipt(body))
            if body.get("tools"):
                if isinstance(body["tool_choice"], dict):
                    return Response(b'data: {"choices":[{"delta":{"content":"ordinary text"},"finish_reason":"stop"}]}\n\n',
                                    content_type="text/event-stream")
                value = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
                return streamed_tool(value)
            if body["stream"]:
                return Response(b'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
                                content_type="text/event-stream")
            return message("582941" if isinstance(body["messages"][0]["content"], list) else "OK")
        with patch.object(probe, "image_challenge", return_value=("582941", "data:image/png;base64,fixture")):
            result = await self.run_probe(list(probe.CHECKS), handler, {**CONF, "compatibility": {"toolChoice": "named"}})
        self.assertTrue(all(check["status"] == "passed" for check in result["checks"].values()), result)
        self.assertEqual(len(self.requests), 7)
        self.assertEqual(result["compatibility"]["toolChoice"], "auto")

    async def test_named_text_repair_cannot_spend_a_third_negotiation(self):
        def handler(body):
            if "max_tokens" in body:
                raise UpstreamError(400, '{"error":{"code":"unsupported_parameter","param":"max_tokens"}}')
            if "stream_options" in body:
                raise UpstreamError(400, '{"error":{"code":"unsupported_parameter","param":"stream_options"}}')
            if body.get("tools") or body["stream"]:
                return Response(b'data: {"choices":[{"delta":{"content":"ordinary text"},"finish_reason":"stop"}]}\n\n',
                                content_type="text/event-stream")
            return message()
        result = await self.run_probe(["connection", "toolCalling"], handler, {**CONF, "compatibility": {"toolChoice": "named"}})
        self.assertEqual(result["checks"]["toolCalling"]["detailCode"], "tool_call_count_mismatch")
        self.assertEqual(len(self.requests), 4)
        self.assertTrue(all(isinstance(body.get("tool_choice"), dict) for body in self.requests if body.get("tools")))
        self.assertEqual(result["compatibility"]["toolChoice"], "named")

    async def test_json_tool_support_does_not_prove_streamed_tool_support(self):
        def handler(body):
            if body.get("stream") and body.get("tools"):
                raise UpstreamError(400, '{"error":{"message":"streamed tools request not accepted"}}')
            if has_tool_result(body):
                return stream_message(receipt(body))
            value = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
            return message(None, tool_calls=[{"id": "json-only", "type": "function", "function": {
                "name": "soduwork_capability_echo", "arguments": json.dumps({"value": value})}}])
        result = await self.run_probe(["toolCalling"], handler)
        self.assertTrue(self.requests[0]["stream"])
        self.assertEqual(result["checks"]["toolCalling"]["status"], "inconclusive")
        self.assertEqual(len(self.requests), 1)

    async def test_streamed_tool_fragments_assemble_id_name_arguments_and_safe_receipt(self):
        def handler(body):
            if has_tool_result(body):
                return stream_message(receipt(body))
            value = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
            return streamed_tool(value, reasoning=True)
        result = await self.run_probe(["toolCalling"], handler)
        self.assertEqual(result["checks"]["toolCalling"]["status"], "passed")
        self.assertTrue(result["reasoningStreamReported"])
        self.assertTrue(self.requests[0]["stream"])
        self.assertTrue(self.requests[-1]["stream"])
        replay = self.requests[-1]["messages"][-2]
        self.assertEqual(replay["tool_calls"][0]["id"], "call-fixture")
        self.assertEqual(replay["tool_calls"][0]["function"]["name"], "soduwork_capability_echo")
        self.assertEqual(replay["reasoning_content"], "synthetic thought")
        self.assertEqual(len(self.requests), 2)

    async def test_streamed_tool_wrong_multiple_and_incomplete_calls_do_not_receive_results(self):
        fixtures = [{"name": "unrequested_function"}, {"extra": True}, {"arguments": '{"value":'},
                    {"arguments": '{"value":"wrong"}'}, {"finish": "stop"}, {"finish": None}]
        for options in fixtures:
            def handler(body):
                value = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
                return streamed_tool(value, **options)
            result = await self.run_probe(["toolCalling"], handler)
            self.assertEqual(result["checks"]["toolCalling"]["status"], "inconclusive")
            self.assertEqual(len(self.requests), 1)

    async def test_streamed_tool_truncation_in_stream_error_and_byte_limit_are_inconclusive(self):
        fixtures = [({"finish": "length"}, "response_truncated"), ({"error": True}, "stream_error"),
                    ({"finish": None, "done": False}, "stream_incomplete")]
        for options, code in fixtures:
            def handler(body):
                value = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
                return streamed_tool(value, **options)
            result = await self.run_probe(["toolCalling"], handler)
            self.assertEqual(result["checks"]["toolCalling"]["code"], code)
            self.assertEqual(len(self.requests), 1)
        with patch.object(probe, "MAX_BYTES", 32):
            result = await self.run_probe(["toolCalling"], lambda body: streamed_tool("ignored"))
        self.assertEqual(result["checks"]["toolCalling"]["code"], "response_limit")

    async def test_streamed_tool_requires_one_zero_index_call_and_stop_receipt(self):
        for index in (1, -1, True, 16):
            def handler(body):
                if has_tool_result(body):
                    return stream_message(receipt(body))
                value = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
                data = streamed_tool(value).data.replace(b'"index": 0, "id"',
                    ('"index": ' + json.dumps(index) + ', "id"').encode())
                return Response(data, content_type="text/event-stream")
            result = await self.run_probe(["toolCalling"], handler)
            self.assertEqual(result["checks"]["toolCalling"]["status"], "inconclusive")
            self.assertEqual(len(self.requests), 1)
        for finish in (None, "tool_calls"):
            def handler(body):
                if has_tool_result(body):
                    return stream_message(receipt(body), finish=finish)
                value = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
                return streamed_tool(value)
            result = await self.run_probe(["toolCalling"], handler)
            self.assertEqual(result["checks"]["toolCalling"]["status"], "inconclusive")
            self.assertEqual(len(self.requests), 2)
            self.assertEqual(result["checks"]["toolCalling"].get("detailCode"), "tool_result_finish_reason_mismatch")

    async def test_streamed_tool_timeout_never_sends_receipt_or_publishes_success(self):
        class DeadlineResponse(Response):
            async def chunks(self):
                yield self.data
                try:
                    await asyncio.sleep(1)
                except asyncio.CancelledError:
                    return
        def handler(body):
            value = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
            return DeadlineResponse(streamed_tool(value).data, content_type="text/event-stream")
        with patch.object(probe, "TIMEOUT", .01):
            result = await self.run_probe(["toolCalling"], handler)
        self.assertEqual(result["checks"]["toolCalling"]["code"], "timeout")
        self.assertEqual(len(self.requests), 1)

    async def test_complete_run_with_streamed_tools_and_two_parameter_retries_uses_seven_calls(self):
        def handler(body):
            if isinstance(body.get("tool_choice"), dict):
                raise UpstreamError(400, '{"error":{"code":"unsupported_parameter","param":"tool_choice"}}')
            if body.get("stream_options"):
                raise UpstreamError(400, '{"error":{"code":"unsupported_parameter","param":"stream_options"}}')
            if has_tool_result(body):
                return stream_message(receipt(body))
            if body.get("tools"):
                value = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
                return streamed_tool(value)
            if body.get("stream"):
                return Response(b'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
                                content_type="text/event-stream")
            return message("123456" if isinstance(body["messages"][0]["content"], list) else "OK")
        with patch.object(probe, "image_challenge", return_value=("123456", "data:image/png;base64,fixture")):
            result = await self.run_probe(list(probe.CHECKS), handler, {**CONF, "compatibility": {"toolChoice": "named"}})
        self.assertTrue(all(check["status"] == "passed" for check in result["checks"].values()), result)
        self.assertEqual(len(self.requests), 7)
        self.assertEqual(result["compatibility"]["toolChoice"], "auto")
        self.assertIs(result["compatibility"]["streamOptions"], False)

    async def test_stream_options_rejection_is_not_streaming_unsupported(self):
        def handler(body):
            if "stream_options" in body:
                raise UpstreamError(400, json.dumps({"error": {"code": "unsupported_parameter",
                    "param": "stream_options", "message": "stream_options is not supported"}}))
            return Response(b'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
                            content_type="text/event-stream")
        result = await self.run_probe(["streaming"], handler)
        self.assertEqual(result["checks"]["streaming"]["status"], "passed")
        self.assertIs(result["compatibility"]["streamOptions"], False)

    async def test_text_only_parameter_refusal_does_not_mark_feature_unsupported(self):
        for check, text in (("toolCalling", "tool_choice is unsupported"),
                            ("streaming", "stream_options is not supported")):
            self.assertEqual(probe._failure(UpstreamError(400, text), check)[0], "inconclusive")

    async def test_generic_bad_request_never_negotiates_or_claims_unsupported(self):
        def reject(body):
            raise UpstreamError(400, '{"error":{"message":"invalid model request"}}')
        result = await self.run_probe(["streaming"], reject)
        self.assertEqual(result["checks"]["streaming"]["status"], "inconclusive")
        self.assertEqual(len(self.requests), 1)

    async def test_saved_thinking_output_and_working_compatibility_shape_requests(self):
        conf = {**CONF, "config": {"thinkingMode": "always", "reasoning": True,
            "thinkingFormat": "openai", "supportsReasoningEffort": True,
            "thinkingLevelMap": {"off": None, "low": "low"}, "maxOutputTokens": 1024},
            "compatibility": {"maxTokensField": "max_completion_tokens", "streamOptions": False}}
        result = await self.run_probe(["connection"], lambda body: message(), conf)
        self.assertEqual(result["checks"]["connection"]["status"], "passed")
        self.assertEqual(self.requests[0].get("reasoning_effort"), "low")
        self.assertNotIn("max_tokens", self.requests[0])
        self.assertLessEqual(self.requests[0]["max_completion_tokens"], 1024)

    async def test_output_parameter_failure_can_negotiate_only_once_per_variant(self):
        def handler(body):
            if "max_tokens" in body:
                raise UpstreamError(400, json.dumps({"error": {"code": "unsupported_parameter",
                    "param": "max_tokens", "message": "Use max_completion_tokens instead"}}))
            return message()
        result = await self.run_probe(["connection"], handler)
        self.assertEqual(result["checks"]["connection"]["status"], "passed")
        self.assertEqual(result["compatibility"]["maxTokensField"], "max_completion_tokens")
        self.assertEqual(len(self.requests), 2)

    async def test_two_parameter_negotiation_limit_is_global_to_run(self):
        def reject(body):
            param = "max_tokens" if "max_tokens" in body else "max_completion_tokens"
            raise UpstreamError(400, json.dumps({"error": {"code": "unsupported_parameter", "param": param}}))
        result = await self.run_probe(list(probe.CHECKS), reject)
        self.assertLessEqual(len(self.requests), 6)
        self.assertTrue(all(item["status"] == "inconclusive" for item in result["checks"].values()))

    async def test_stream_decodes_split_utf8_multiline_data_crlf_and_heartbeats(self):
        data = (': heartbeat\r\nevent: message\r\ndata: {"choices":[\r\n'
                'data: {"delta":{"content":"你好"},"finish_reason":null}]}\r\n\r\n'
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\r').encode()
        response = Response(data, content_type="text/event-stream", chunks=[bytes([byte]) for byte in data])
        result = await self.run_probe(["streaming"], lambda body: response)
        self.assertEqual(result["checks"]["streaming"]["status"], "passed")

    async def test_stream_needs_terminal_evidence_and_nonempty_meaningful_delta(self):
        fixtures = [b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
                    b'data: {"choices":[{"delta":{"content":"  "},"finish_reason":"stop"}]}\n\n',
                    b'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: [DONE]\n\n']
        for data in fixtures:
            result = await self.run_probe(["streaming"], lambda body: Response(data, content_type="text/event-stream"))
            self.assertEqual(result["checks"]["streaming"]["status"], "inconclusive")

    async def test_stream_error_truncation_invalid_utf8_and_limit_never_pass(self):
        start = b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
        fixtures = [(start + b'event: error\ndata: {"error":{"message":"private fixture"}}\n\n', "stream_error"),
                    (start + b'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n', "response_truncated"),
                    (start + b'\xff\n\ndata: [DONE]\n\n', "invalid_response"),
                    (start + b': ' + b'x' * probe.MAX_BYTES, "response_limit")]
        for data, code in fixtures:
            result = await self.run_probe(["streaming"], lambda body: Response(data, content_type="text/event-stream"))
            self.assertEqual(result["checks"]["streaming"]["code"], code)
            self.assertEqual(result["checks"]["streaming"]["status"], "inconclusive")

    async def test_json_response_to_stream_request_is_not_stream_verification(self):
        result = await self.run_probe(["streaming"], lambda body: message())
        self.assertEqual(result["checks"]["streaming"]["code"], "stream_not_observed")

    async def test_named_sse_heartbeats_do_not_count_as_model_deltas(self):
        data = (b'event: ping\ndata: {"type":"ping"}\n\n'
                b'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n')
        result = await self.run_probe(["streaming"], lambda body: Response(data, content_type="text/event-stream"))
        self.assertEqual(result["checks"]["streaming"]["status"], "passed")

    async def test_delta_after_finish_is_an_invalid_stream(self):
        data = (b'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n'
                b'data: {"choices":[{"delta":{"content":"orphan partial"}}]}\n\n')
        result = await self.run_probe(["streaming"], lambda body: Response(data, content_type="text/event-stream"))
        self.assertEqual(result["checks"]["streaming"]["code"], "invalid_response")

    async def test_tool_arguments_wrong_type_extra_fields_and_missing_receipt_are_inconclusive(self):
        for mutation in (lambda value: {"value": [value]}, lambda value: {"value": value, "execute": True},
                         lambda value: {"value": value}):
            def handler(body):
                if has_tool_result(body):
                    return message("ignored tool result")
                value = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
                return streamed_tool(value, arguments=json.dumps(mutation(value)))
            result = await self.run_probe(["toolCalling"], handler)
            self.assertEqual(result["checks"]["toolCalling"]["status"], "inconclusive")

    async def test_non_chat_completions_protocol_is_explicitly_not_tested(self):
        result = await self.run_probe(["connection"], lambda body: self.fail("must not call upstream"),
                                      {**CONF, "kind": "anthropic"})
        self.assertEqual(result["checks"]["connection"]["code"], "protocol_not_tested")

    async def test_controllable_and_baseten_thinking_follow_saved_dialect(self):
        fixtures = [("controllable", "qwen", "enable_thinking", False),
                    ("always", "baseten", "chat_template_kwargs", {"enable_thinking": True}),
                    ("always", "zai", "thinking", {"type": "enabled", "clear_thinking": False})]
        for mode, dialect, field, value in fixtures:
            conf = {**CONF, "config": {"thinkingMode": mode, "thinkingFormat": dialect, "reasoning": True}}
            await self.run_probe(["connection"], lambda body: message(), conf)
            self.assertEqual(self.requests[0].get(field), value)

    async def test_always_thinking_budget_has_headroom_and_obeys_saved_context(self):
        conf = {**CONF, "contextWindow": 1536, "config": {"thinkingMode": "always", "maxOutputTokens": 4096}}
        await self.run_probe(["connection"], lambda body: message(), conf)
        self.assertEqual(self.requests[0]["max_tokens"], 1536)

    async def test_run_deadline_bounds_all_requests_not_only_individual_idle_time(self):
        async def slow(body):
            await asyncio.sleep(1)
            return message()
        with patch.object(probe, "TOTAL_TIMEOUT", .04), patch.object(probe, "TIMEOUT", .03):
            result = await self.run_probe(list(probe.CHECKS), slow)
        self.assertLessEqual(len(self.requests), 2)
        self.assertEqual(result["checks"]["streaming"]["code"], "budget_exhausted")

    async def test_transport_suppressing_timeout_cannot_publish_stream_success(self):
        class DeadlineResponse(Response):
            async def chunks(self):
                yield self.data
                try:
                    await asyncio.sleep(1)
                except asyncio.CancelledError:
                    return
        data = b'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n'
        with patch.object(probe, "TIMEOUT", .01):
            result = await self.run_probe(["streaming"], lambda body: DeadlineResponse(data, content_type="text/event-stream"))
        self.assertEqual(result["checks"]["streaming"]["status"], "inconclusive")
        self.assertEqual(result["checks"]["streaming"]["code"], "timeout")

    async def test_billing_and_known_structured_capability_refusals_are_safe(self):
        for check, code in (("imageInput", "unsupported_image_input"),
                            ("toolCalling", "unsupported_tools"), ("streaming", "streaming_not_supported")):
            result = probe._failure(UpstreamError(400, json.dumps({"error": {"code": code,
                "message": "private fixture text"}})), check)
            self.assertEqual(result, ("unsupported", "capability_not_supported"))
        self.assertEqual(probe._failure(UpstreamError(400, '{"error":{"code":"insufficient_quota"}}'),
                                       "imageInput"), ("failed", "billing_unavailable"))


class EvidenceTests(unittest.TestCase):
    def test_legacy_tool_and_stream_passes_require_recheck_but_preserve_other_evidence_and_declarations(self):
        legacy = {"reportVersion": 1, "checks": {
            "toolCalling": {"status": "passed", "checkedAt": "old"},
            "streaming": {"status": "passed", "checkedAt": "old"},
            "imageInput": {"status": "passed", "checkedAt": "old"},
            "connection": {"status": "passed", "checkedAt": "old"}}}
        profile = caps.profile({}, legacy)
        self.assertEqual(profile["toolCalling"]["state"], "unknown")
        self.assertEqual(profile["toolCalling"]["checkStatus"], "inconclusive")
        self.assertEqual(caps.public_evidence(legacy)["checks"]["toolCalling"]["code"], "legacy_recheck_required")
        self.assertEqual(profile["streaming"]["state"], "unknown")
        self.assertEqual(caps.public_evidence(legacy)["checks"]["streaming"]["code"], "legacy_recheck_required")
        self.assertEqual(legacy["checks"]["toolCalling"]["status"], "passed")
        self.assertEqual(profile["imageInput"]["state"], "supported")
        self.assertEqual(caps.evidence_checks(legacy)["connection"]["status"], "passed")
        declared = caps.profile({"capabilities": {"toolCalling": "supported"}}, legacy)
        self.assertEqual(declared["toolCalling"]["source"], "configured")
        unsupported = {"reportVersion": 1, "checks": {"toolCalling": {
            "status": "unsupported", "code": "capability_not_supported", "checkedAt": "old"}}}
        self.assertEqual(caps.profile({}, unsupported)["toolCalling"]["state"], "unknown")
        self.assertEqual(caps.profile({}, {**unsupported, "reportVersion": 2})["toolCalling"]["state"], "unsupported")

    def test_connection_only_v2_merge_cannot_promote_legacy_json_tool_pass(self):
        legacy = {"reportVersion": 1, "configRevision": "same", "checks": {
            "toolCalling": {"status": "passed", "checkedAt": "old"},
            "imageInput": {"status": "passed", "checkedAt": "old"}}}
        result = caps.merge_evidence(legacy, {"reportVersion": 2, "apiFamily": "chat-completions",
            "configRevision": "same", "checks": {"connection": {"status": "passed", "checkedAt": "new"}}})
        self.assertEqual(result["checks"]["toolCalling"]["status"], "inconclusive")
        self.assertNotIn("toolCalling", result["verifiedChecks"])
        self.assertEqual(result["verifiedChecks"]["imageInput"]["status"], "passed")
        self.assertEqual(caps.profile({}, result)["toolCalling"]["state"], "unknown")

    def test_v1_optional_control_false_negatives_cannot_block_or_be_promoted_by_new_merge(self):
        legacy = {"reportVersion": 1, "configRevision": "same", "checks": {
            key: {"status": "unsupported", "code": "capability_not_supported", "checkedAt": "old"}
            for key in ("toolCalling", "streaming")}}
        result = caps.merge_evidence(legacy, {"reportVersion": 2, "apiFamily": "chat-completions",
            "configRevision": "same", "checks": {"connection": {"status": "passed", "checkedAt": "new"}}})
        for key in ("toolCalling", "streaming"):
            self.assertEqual(result["checks"][key]["status"], "inconclusive")
            self.assertEqual(result["checks"][key]["code"], "legacy_recheck_required")
            self.assertNotIn(key, result["verifiedChecks"])
            self.assertEqual(caps.profile({}, result)[key]["state"], "unknown")

    def test_shared_desktop_and_hub_capability_vectors(self):
        fixture = Path(__file__).resolve().parents[1] / "tools/contracts/model-capabilities-v2.json"
        for case in json.loads(fixture.read_text(encoding="utf-8"))["cases"]:
            with self.subTest(case["name"]):
                actual = caps.runtime_fields(case["config"], case["evidence"])
                for key, expected in case["expected"]["imageInput"].items():
                    self.assertEqual(actual["capabilityProfile"]["imageInput"].get(key), expected)
                self.assertEqual(actual["imageRouting"], case["expected"]["imageRouting"])
                self.assertEqual(actual.get("input"), case["expected"]["input"])

    def test_malformed_evidence_does_not_break_catalog_projection(self):
        for evidence in ({"checks": [], "verifiedChecks": [], "compatibility": None},
                         {"checks": [1], "verifiedChecks": [1], "compatibility": []},
                         {"checks": {"imageInput": "passed"}},
                         {"verifiedChecks": {"streaming": None}}):
            try:
                result = caps.runtime_fields({}, evidence)
            except (TypeError, AttributeError) as error:
                self.fail("malformed stored evidence broke projection: " + type(error).__name__)
            self.assertEqual(result["capabilityProfile"]["imageInput"]["state"], "unknown")

    def test_transient_latest_check_retains_last_conclusive_capability(self):
        evidence = {"reportVersion": 2, "apiFamily": "chat-completions",
            "checks": {"imageInput": {"status": "inconclusive", "checkedAt": "later"}},
            "verifiedChecks": {"imageInput": {"status": "passed", "checkedAt": "earlier"}}}
        fields = caps.runtime_fields({}, evidence)
        self.assertEqual(fields["capabilityProfile"]["imageInput"]["state"], "supported")
        self.assertEqual(fields["capabilityProfile"]["imageInput"]["checkStatus"], "inconclusive")
        self.assertEqual(fields["imageRouting"], "native")

    def test_runtime_revision_ignores_probe_dates_and_diagnostics(self):
        one = caps.runtime_fields({}, {"checks": {"imageInput": {"status": "passed", "checkedAt": "one"}}})
        two = caps.runtime_fields({}, {"checks": {"imageInput": {"status": "passed", "checkedAt": "two", "code": "verified"}}})
        self.assertEqual(caps.runtime_revision("target", one), caps.runtime_revision("target", two))

    def test_manual_declaration_wins_but_conflicting_verified_evidence_is_visible(self):
        profile = caps.profile({"capabilities": {"toolCalling": "supported"}},
            {"reportVersion": 2, "checks": {"toolCalling": {"status": "unsupported", "checkedAt": "now"}}})
        self.assertEqual(profile["toolCalling"]["source"], "configured")
        self.assertTrue(profile["toolCalling"].get("conflict"))

    def test_other_protocol_evidence_cannot_enable_chat_completions_runtime(self):
        fields = caps.runtime_fields({}, {"apiFamily": "responses", "reasoningStreamReported": True,
            "checks": {"imageInput": {"status": "passed"}}, "compatibility": {"streamOptions": False}})
        self.assertEqual(fields["capabilityProfile"]["imageInput"]["state"], "unknown")
        self.assertEqual(fields["capabilityProfile"]["reasoningStream"]["state"], "unknown")


if __name__ == "__main__":
    unittest.main()
