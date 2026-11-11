"""Static product contract for governed MCP administration."""
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]
FRONT = ROOT / "hub-frontend" / "src"
BACK = ROOT / "hub-backend" / "app"
checks = 0


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def ok(condition: bool, message: str) -> None:
    global checks
    if not condition:
        raise AssertionError(message)
    checks += 1


screen = read(FRONT / "screens" / "McpServers.jsx")
form = read(FRONT / "screens" / "McpConnectionForm.jsx")
form_style = read(FRONT / "screens" / "McpConnectionForm.css")
skills = read(FRONT / "screens" / "Skills.jsx")
style = read(FRONT / "screens" / "capability-center.css")
admin = read(BACK / "api" / "admin.py")
service = read(BACK / "services" / "mcp_servers.py")
runner = read(ROOT / "hub-backend" / "runner_main.py")

ok("probe_managed" in service and "await mcp.probe_managed" in admin,
   "admin probes must route stdio MCP to an online Runner")
ok(all(operation in runner for operation in ("mcp.probe", "mcp.list", "mcp.call")),
   "Runner must implement the governed MCP lifecycle")
ok("HTTP 由 Hub 调用" in screen and "stdio 由在线 Runner 执行" in screen,
   "operators must see where every MCP transport executes")
ok("await api.probeMcpServer(spec)" in form and "if (!result?.ok) return" in form
   and "probe.error || probe.message" in form,
   "failed or offline probes must explain the error and prevent connection enablement")
ok("runtimeFile" not in screen + form and "凭据不会回显" in screen,
   "MCP UI must not leak internal paths or plaintext credentials")
ok('className="connector-advanced"' in form and "<details" in form
   and "高级设置" in form,
   "advanced identity configuration must stay available without overwhelming the main form")
ok("probe.authenticationTested" in form and "业务授权尚未验证" in form
   and "连接配置已就绪" in form,
   "configured connections must not be presented as verified business authorization")
ok('<option value="http">' in form and '<option value="stdio">' in form
   and "远程连接" in form and "设备上的工具" in form,
   "connection modes must remain explicit in the shared configuration form")
ok("grid-template-columns:repeat(3,minmax(0,1fr))" in style
   and "@media(max-width:1180px)" in style
   and "@media(max-width:780px)" in style,
   "trusted templates and connection controls must adapt across common admin widths")
ok("cap-admin-metrics" in skills and 'aria-label={tx("能力汇总")}' in skills
   and not re.search(r'''<h2>(?:\{tx\(["'])?公司能力目录''', skills),
   "capability management must not repeat the shell page title")
sizes = [float(value) for value in re.findall(
    r"font-size:\s*([0-9.]+)px", style + form_style)]
ok(sizes and min(sizes) >= 10,
   "capability administration text must remain commercially readable")
# Physical source sizes are reviewed by tools/check-source-size.cjs (advisory).

print(f"mcp UI: {checks} checks passed")
