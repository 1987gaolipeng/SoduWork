"""Runner organization scope smoke; no live service or database writes."""
import os
import sys
import time
from types import SimpleNamespace

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///.smoke-runner-scope.db"
sys.path.insert(0, ".")

from app.api import runner_ws
from app.services import runner_hub, runner_release

ok = bad = 0


def chk(name, value):
    global ok, bad
    ok += int(bool(value))
    bad += int(not value)
    print(("  PASS  " if value else "  FAIL  ") + name)


class R:
    def __init__(self, rid, client="", org="", cli="pi"):
        self.id, self.client_id, self.org_id = rid, client, org
        self.host, self.tags = rid, []
        self.agents = [{"key": cli}]
        self.capabilities, self.busy = None, 0
        self.connected_at = self.last_beat = time.time()
        self.dispatch_mode = "accepting"
        self.ready = True
        self.inventory_ready = True

    def alive(self):
        return True


owned = R("owned", "client-a", "org-a")
shared_a = R("shared-a", org="org-a", cli="opencode")
shared_b = R("shared-b", org="org-b", cli="opencode")
unassigned = R("unassigned", cli="opencode")

chk("embedded requires owned client",
    runner_hub.in_scope(owned, {"client-a"}, {"org-a"})
    and not runner_hub.in_scope(owned, {"client-b"}, {"org-a"}))
chk("shared runner requires allowed org",
    runner_hub.in_scope(shared_a, {"client-a"}, {"org-a"})
    and not runner_hub.in_scope(shared_b, {"client-a"}, {"org-a"}))
chk("unassigned runner fails closed",
    not runner_hub.in_scope(unassigned, {"client-a"}, {"org-a"})
    and not runner_hub.can_dispatch(unassigned))
chk("admin and hub use the same boundary",
    runner_ws._row_in_scope(SimpleNamespace(client_id="", org_id="org-a", owner_user_id=""),
                            {"client-a"}, {"org-a"})
    and not runner_ws._row_in_scope(
        SimpleNamespace(client_id="", org_id="org-b", owner_user_id=""),
        {"client-a"}, {"org-a"}))

private = SimpleNamespace(client_id="client-a", org_id="org-a", owner_user_id="user-a")
chk("personal runner does not become shared through an allowed organization",
    not runner_ws._row_in_scope(private, {"client-a"}, {"org-a"})
    and not runner_ws._row_in_scope(private, None, None, "user-b"))
chk("personal runner remains accessible to its account owner",
    runner_ws._row_in_scope(private, {"client-a"}, {"org-a"}, "user-a"))

saved = dict(runner_hub._RUNNERS)
runner_hub._RUNNERS.clear()
runner_hub._RUNNERS.update({x.id: x for x in (owned, shared_a, shared_b, unassigned)})
try:
    chk("owner desktop is preferred",
        runner_hub.pick_for("client-a", "pi", {"client-a"},
                            allowed_org_ids={"org-a"}) is owned)
    chk("shared runner stays inside tenant",
        runner_hub.pick_for("client-a", "opencode", {"client-a"},
                            allowed_org_ids={"org-a"}) is shared_a)
    chk("other tenant runner is never borrowed",
        runner_hub.pick_for("client-a", "opencode", {"client-a"},
                            allowed_org_ids={"org-b"}) is shared_b)
    chk("unassigned runner is not dispatchable",
        unassigned not in runner_hub.dispatchable())
finally:
    runner_hub._RUNNERS.clear()
    runner_hub._RUNNERS.update(saved)

row = {"runnerId": "unassigned", "shared": True, "scopeState": "unassigned",
       "online": True, "accepting": False, "busy": 0, "mode": "accepting",
       "lastSeen": int(time.time()), "version": runner_release.RUNNER_VERSION,
       "embedded": False, "authState": "active"}
summary = runner_release.enrich([row])["summary"]
chk("unassigned runner needs attention",
    row["health"]["state"] == "unassigned" and summary["attention"] == 1)

print("\n%d passed / %d failed" % (ok, bad))
sys.exit(1 if bad else 0)
