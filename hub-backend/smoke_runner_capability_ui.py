"""Static contract checks for Runner capability visibility.

This test stays offline and protects the product promise that capability-aware
scheduling is understandable to employees and administrators, not hidden in
backend logs.
"""
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
CLIENT_JS = ROOT / "client/components/panels/panels-runners.js"
CLIENT_CSS = ROOT / "client/components/panels/panels-runners.css"
ADMIN_JSX = ROOT / "hub-frontend/src/screens/RunnerBoard.jsx"
ADMIN_CSS = ROOT / "hub-frontend/src/screens/runner-board.css"

checks = 0


def expect(condition: bool, message: str) -> None:
    global checks
    assert condition, message
    checks += 1


client_js = CLIENT_JS.read_text(encoding="utf-8")
client_css = CLIENT_CSS.read_text(encoding="utf-8")
admin_jsx = ADMIN_JSX.read_text(encoding="utf-8")
admin_css = ADMIN_CSS.read_text(encoding="utf-8")
ui_text = "\n".join((client_js, client_css, admin_jsx, admin_css))

expect(client_js.count("const _RN_CAP_KEYS") == 1,
       "client must keep one canonical capability presentation order")
expect("_rnCapabilitiesHtml(capabilityReport, r, working)" in client_js,
       "each client Runner card must render the real capability report")
expect("capabilities: d.capabilities || null" in client_js,
       "an inline probe must refresh capability facts immediately")
expect("Number(report.reportedAt || 0) > 0" in client_js,
       "old Runners must not be mistaken for machines with a valid report")
expect("等待上报" in client_js and "Runner 1.7.0" in client_js,
       "client must explain how an unreported machine becomes ready")
expect("runner.embedded && runner.owned" in client_js and "data-rn-cap-set" in client_js,
       "only this device may expose local Runner capability controls")
expect("setRunnerCapability" in client_js and "授权已生效" in client_js,
       "local capability changes must restart and probe the Runner inline")
expect(".rn-cap-settings" in client_css and ".rn-cap-toggle" in client_css,
       "local capability controls must use a compact, collapsed settings region")
expect(".rn-cap.is-ready" in client_css and ".rn-cap.is-missing" in client_css,
       "client must distinguish ready and unavailable capabilities")
expect("function RunnerCapabilities" in admin_jsx,
       "admin Runner inventory must have a reusable capability presenter")
expect(any(header in admin_jsx for header in ("<th>执行能力</th>", '<th>{tx("执行能力")}</th>')),
       "admin inventory must expose capability facts as a first-class column")
expect("<RunnerCapabilities report={r.capabilities} row={r}" in admin_jsx
       and "onInstall={(row, key) => setConfirm({" in admin_jsx
       and "run: () => { void installComponent(row, key) }" in admin_jsx,
       "admin capability view must use persisted facts and governed install actions")
expect(".rb-cap.is-ready" in admin_css and ".rb-cap.is-missing" in admin_css,
       "admin must visually distinguish ready and unavailable capabilities")
expect("min-width:238px;max-width:290px" in admin_css,
       "admin capability cell must remain compact instead of becoming a large card")
expect(not any(token in ui_text for token in ("鏂", "鑳", "绛", "鍗囩骇")),
       "Runner capability UI contains mojibake")

print(f"Runner capability UI smoke passed: {checks} checks")
