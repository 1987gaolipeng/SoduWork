"""Exercise real Harness2 refinement and handoff with synthetic model/vendor IO."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.services import acp_bridge, harness2_bridge
from tests.harness2_fixture_model import complete as fixture_complete, model_calls

native_init = acp_bridge.AcpBridge.__init__
model_calls = []


def fixture_complete(model, messages, on_usage=None, *, timeout=20):
    model_calls.append(messages)
    if on_usage:
        on_usage({"input_tokens": 10, "output_tokens": 10})
    if "SODUWORK_HARNESS2_EDIT" in messages[0]["content"]:
        return json.dumps({"files": {"systemprompt.md": "Preserve the handoff context and verify the result."},
                           "notes": "Keep the supplied request and permission boundaries."})
    return "Inspect the handoff context, complete the request and verify its result."


def fixture_vendor(self, argv, *args, **kwargs):
    assert len(model_calls) == 7, "handoff must refine before starting the vendor"
    assert argv == [sys.executable, "acp"], "only the synthetic executor may be replaced"
    peer = str(Path(__file__).with_name("handoff_vendor_peer.py"))
    native_init(self, [sys.executable, peer, "opencode"], *args, **kwargs)


acp_bridge.AcpBridge.__init__ = fixture_vendor
harness2_bridge.complete = fixture_complete
raise SystemExit(harness2_bridge.main())
