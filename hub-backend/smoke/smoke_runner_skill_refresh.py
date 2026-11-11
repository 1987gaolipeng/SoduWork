# -*- coding: utf-8 -*-
"""Runner Skill catalog: provenance, redaction and deterministic precedence."""
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

from app.services import runner_hub, skills  # noqa: E402
import runner_main  # noqa: E402


checks = 0


def check(value, message):
    global checks
    assert value, message
    checks += 1


clean = runner_hub.clean_skill_catalog([{
    "name": "native-review",
    "description": "Review changes.",
    "sourceKey": "codex",
    "path": "C:/secret/skill",
    "instructions": "never upload this",
}])
check(len(clean) == 1, clean)
check(clean[0]["source"] == "Codex", clean)
check("path" not in clean[0] and "instructions" not in clean[0], clean)

report = runner_main._skill_report([{
    "name": "pi-research",
    "description": "Research.",
    "source": "Pi",
    "sourceKey": "pi",
    "path": "C:/private/pi-research",
    "body": "private instructions",
}])
check(report[0]["sourceKey"] == "pi", report)
check("path" not in report[0] and "body" not in report[0], report)


class Client:
    id = "client-1"


class Runner:
    id = "runner-1"
    skills = ["governed-review", "local-notes"]
    skill_catalog = [
        {"name": "governed-review", "source": "Pi", "sourceKey": "pi",
         "version": "stale"},
        {"name": "local-notes", "description": "Local notes.",
         "source": "Codex", "sourceKey": "codex", "version": "1.2.3"},
    ]


governed = {
    "name": "governed-review",
    "description": "Approved enterprise version.",
    "scope": "company",
    "root": "C:/hub/company",
    "path": "C:/hub/company/governed-review",
    "dir": "governed-review",
    "bundled": True,
    "packageChecksum": "a" * 64,
}
real_scan = skills.scan
real_for_client = runner_hub.for_client
try:
    skills.scan = lambda extra_roots=None, owner_client_id="": [dict(governed)]
    runner_hub.for_client = lambda client_id: Runner() if client_id == "client-1" else None
    rows = skills.available_for_client([], Client())
finally:
    skills.scan = real_scan
    runner_hub.for_client = real_for_client

by_name = {item["name"]: item for item in rows}
shared = by_name["governed-review"]
local = by_name["local-notes"]
check(shared["scope"] == "company", shared)
check(shared["description"] == "Approved enterprise version.", shared)
check(shared["runtimeAvailable"] is False, shared)
check(shared["runtimeSources"] == [{"key": "pi", "label": "Pi"}], shared)
check(local["scope"] == "local" and local["runtimeLocal"] is True, local)
check(not local["path"] and not local["root"], local)

public = skills.public_view(local, enabled=True)
check(public["sourceKey"] == "codex" and public["localOnly"] is True, public)
check(public["version"] == "1.2.3", public)
check("path" not in public and "root" not in public, public)

extra_root = os.path.abspath(os.path.join(HERE, ".smoke-soduwork-skills"))
before_roots = os.environ.get("SODUWORK_SKILL_ROOTS")
try:
    os.environ["SODUWORK_SKILL_ROOTS"] = extra_root
    check(extra_root in skills.configured_roots(), skills.configured_roots())
    check(skills.source_info({"root": extra_root}) == ("SoduWork 本机", "soduwork"),
          skills.source_info({"root": extra_root}))
finally:
    if before_roots is None:
        os.environ.pop("SODUWORK_SKILL_ROOTS", None)
    else:
        os.environ["SODUWORK_SKILL_ROOTS"] = before_roots

print("PASS=%d FAIL=0" % checks)
