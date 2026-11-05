"""Finite resource budget for Harness² user turns and refinement diagnostics."""
from __future__ import annotations

import json
import time
from typing import Callable

from .harness2_errors import StructuredFailure

MAX_CALLS = 7
MAX_SECONDS = 420.0
MAX_REQUEST_SECONDS = 300.0
MAX_OUTPUT_TOKENS = 32768
# A user turn replays the full task in four probes and three proposals. These
# are whole-turn accounting and per-request wire limits, respectively; the old
# diagnostic limits could reject the second stage of a normal Runner prompt.
# Reasoning models may include hidden reasoning in their output allowance, so
# a short JSON proposal still needs headroom beyond 8192 tokens. The cumulative
# budget remains independent of this allowance; smaller configured limits win.
# Seven sequential reasoning calls need a separate planning deadline; a single
# healthy proposal can exceed 90 seconds even when its visible answer is short.
# Align the request ceiling with the Hub model transport's read allowance, then
# clamp every request to the remaining whole-turn deadline below.
MAX_REPORTED_TOKENS = 128000
MAX_PROMPT_BYTES = 128000


class RefinementBudget:
    """Retain numeric accounting only; provider billing is observed after response.

    Transport timeouts and checks at request boundaries cannot guarantee a hard
    provider billing or wall-clock ceiling while an in-flight request is pending.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self.started = clock()
        self.calls = 0
        self.reported_tokens = 0
        self._failed = False

    def _stop(self):
        self._failed = True
        raise StructuredFailure("refinement_budget")

    def _remaining(self) -> float:
        remaining = MAX_SECONDS - (self._clock() - self.started)
        if self._failed or remaining <= 0 or self.reported_tokens >= MAX_REPORTED_TOKENS:
            self._stop()
        return remaining

    @staticmethod
    def _tokens(usage: dict, names: tuple[str, ...]) -> int:
        for name in names:
            if name in usage:
                try:
                    return max(0, int(usage[name] or 0))
                except (TypeError, ValueError, OverflowError):
                    raise StructuredFailure("response_format") from None
        return 0

    def run(self, model: dict, messages: list[dict], complete, on_usage=None) -> str:
        """Run exactly one request; any failure prevents later requests."""
        self._remaining()
        if self.calls >= MAX_CALLS:
            self._stop()
        if len(json.dumps(messages, ensure_ascii=False).encode("utf-8")) > MAX_PROMPT_BYTES:
            self._stop()
        limit = model.get("maxOutputTokens", MAX_OUTPUT_TOKENS)
        if type(limit) is not int or not 1 <= limit <= 262144:
            self._failed = True
            raise StructuredFailure("model_config")
        bounded_model = {**model, "maxOutputTokens": min(limit, MAX_OUTPUT_TOKENS)}

        def usage(tokens):
            # Account and forward real usage without masking a more specific
            # transport/response failure from this same call. Enforce the
            # cumulative budget after complete validates its response.
            count = (self._tokens(tokens, ("input_tokens", "input", "prompt_tokens"))
                     + self._tokens(tokens, ("output_tokens", "output", "completion_tokens")))
            self.reported_tokens += count
            if on_usage:
                on_usage(tokens)

        timeout = min(MAX_REQUEST_SECONDS, self._remaining())
        self.calls += 1
        try:
            result = complete(bounded_model, messages, usage, timeout=timeout)
            self._remaining()
        except Exception:
            self._failed = True
            raise
        return result
