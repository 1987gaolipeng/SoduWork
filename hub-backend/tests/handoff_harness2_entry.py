"""Exercise the real Harness2 bridge with a synthetic OpenCode vendor boundary."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.services import acp_bridge, harness2_bridge

native_init = acp_bridge.AcpBridge.__init__


def fixture_vendor(self, argv, *args, **kwargs):
    assert argv == [sys.executable, "acp"], "only the synthetic executor may be replaced"
    peer = str(Path(__file__).with_name("handoff_vendor_peer.py"))
    native_init(self, [sys.executable, peer, "opencode"], *args, **kwargs)


acp_bridge.AcpBridge.__init__ = fixture_vendor
raise SystemExit(harness2_bridge.main())
