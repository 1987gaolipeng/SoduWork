# -*- coding: utf-8 -*-
"""Offline regressions for Codex CLI integration.

Use fixed success and failure event fixtures without accessing real accounts or model services.
Cover executable resolution, start/resume command shapes, event parsing (session IDs, messages,
context usage, terminal state), and installation/probe metadata.
Run from the hub-backend directory:
    .venv\\Scripts\\python.exe -m smoke.smoke_codex_cli
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, ".")

SMOKE_DATA = tempfile.mkdtemp(prefix="soduwork-smoke-codex-")
os.environ["SODUWORK_DATA_ROOT"] = SMOKE_DATA

from app.services import agent_setup, cli_account_auth, codex_account_acp, local_base, local_stream  # noqa: E402
from app.services.local_base import _PROFILES, _RUNS, _codex_bin  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:260] if extra else ""))


# Verify runtime profile and command arguments.
prof = _PROFILES.get("codex") or {}
chk("_PROFILES 里有 codex（派活名单/探测自动纳入）", bool(prof), list(_PROFILES))
chk("原生账号：needs_llm=False，不注入 Chat Completions 配置",
    prof.get("needs_llm") is False)
chk("会话 id 只能抓不能指定：own_session=False", prof.get("own_session") is False)

# Exercise discovery against an actual temporary npm layout, never the host's
# global packages, private runtime, PATH or account credentials.
vendor = (Path(SMOKE_DATA) / "node_modules" / "@openai" / "codex" / "node_modules"
          / "@openai" / "codex-win32-x64" / "vendor" / "x86_64-pc-windows-msvc"
          / "bin" / "codex.exe")
vendor.parent.mkdir(parents=True)
vendor.write_bytes(b"offline codex fixture; never executed")
# The personal package owns this platform dependency, including a hoisted copy.
(Path(SMOKE_DATA) / "node_modules/@openai/codex/package.json").write_text(
    '{"name":"@openai/codex","version":"0.166.0"}', encoding="utf-8")
with (
    patch.object(local_base, "_WIN", True),
    patch.object(local_base, "_npm_root", return_value=str(Path(SMOKE_DATA) / "node_modules")),
    patch.object(agent_setup.agent_npm_runtime, "runtime_target", return_value=("win32", "x64")),
    patch.object(agent_setup.agent_npm_runtime, "private_bin", return_value=None),
    patch.object(local_base.shutil, "which", return_value=None) as which,
):
    binp = _codex_bin()
    chk("真身定位 npm 平台包 vendor，不执行宿主 Codex", binp == str(vendor), binp)
    vendor.unlink()
    chk("未安装 CLI 时明确缺失", _codex_bin() is None)
    which.return_value = r"C:\Program Files\WindowsApps\OpenAI.Codex_fixture\codex.exe"
    chk("桌面应用 WindowsApps 资源不能冒充 CLI", _codex_bin() is None)
    which.return_value = r"C:\fixture\codex.cmd"
    chk("Windows npm 垫片不能冒充原生 CLI", _codex_bin() is None)

start = prof["start"]("sid-x", "work", r"C:\ws\demo")
chk("干活轮：exec --json + full-access（完整 git 交付）+ 非交互",
    start[0] == "exec" and "--json" in start and "danger-full-access" in start
    and "sandbox_workspace_write.network_access=true" in start, start)
chk("非交互不许挂审批（approval_policy=never）", "approval_policy=never" in start, start)
chk("工作目录经 -C 显式给", "-C" in start and r"C:\ws\demo" in start, start)
plan = prof["start"]("sid-x", "plan", r"C:\ws\demo")
chk("计划轮＝read-only 沙箱（它没有 plan 模式，用沙箱表达只想不改）",
    "read-only" in plan and "workspace-write" not in plan, plan)
resume = prof["resume"]("thread-1", "work", r"C:\ws\demo")
chk("续跑：exec resume <id> 且**不带 -C**（实拍：resume 不认 -C，目录在会话记录里）",
    resume[:3] == ["exec", "resume", "thread-1"] and "-C" not in resume, resume)
chk("★续跑不带 -s（exec resume 不认，0.146/0.147 实拍 unexpected argument；"
    "此前照传 ⇒ 第二轮必死，追问/自动接管/卡住恢复全灭）",
    "-s" not in resume and "danger-full-access" not in resume, resume)
chk("续跑仍带 -c 配置（resume 认 -c，审批策略每轮都要成立）",
    "approval_policy=never" in resume and "--json" in resume, resume)

# ---- Equals-form image attachment options and MCP -c configuration ----
import tempfile  # noqa: E402

_img = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
_img.write(b"png")
_img.close()
cfg_e = {"images": [_img.name, "C:/不存在的截图.png"],
         "mcpConfig": {"playwright": {"command": "npx",
                                      "args": ["-y", "playwright-mcp", "--headless"],
                                      "env": {"X": "1"}},
                       "坏 名!": {"command": "evil"},
                       "no-cmd": {}}}
argv_e = prof["start"]("sid-x", "work", r"C:\ws\demo", cfg_e)
chk("★附图用 --image= 等号形式，避免空格形式吞掉位置参数",
    any(x == "--image=" + _img.name for x in argv_e), argv_e)
chk("不存在的图不带(别让 codex 因坏路径整轮退出)",
    not any("不存在的截图" in x for x in argv_e))
_joined = " ".join(argv_e)
chk("★MCP 翻成 -c mcp_servers.<名>.command/args=<TOML>(codex 无 --mcp-config)",
    'mcp_servers.playwright.command="npx"' in _joined
    and 'mcp_servers.playwright.args=["-y", "playwright-mcp", "--headless"]' in _joined,
    _joined[-200:])
chk("server 名清洗(空格/标点剔除)、没 command 的跳过、env 不翻",
    "坏" not in _joined and "no-cmd" not in _joined and '"X"' not in _joined)
argv_p = prof["start"]("sid-x", "work", r"C:\ws\demo")
chk("不带 cfg 时 argv 与此前完全一致(向后兼容)",
    "--image" not in " ".join(argv_p) and "mcp_servers" not in " ".join(argv_p))
os.unlink(_img.name)

# ---- Event-stream parsing with a fixed synthetic session ID ----
REF = "codex-smoke-ref"
_RUNS[REF] = {"ref": REF, "state": "running", "cli": "codex", "seq": 0, "segment": 1,
              "lines": [], "cfg": {}}
term: dict = {}
LINES_OK = [
    '{"type":"thread.started","thread_id":"00000000-0000-4000-8000-000000000001"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `fake-large` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"SODUWORK_AGENT_OK"}}',
    '{"type":"turn.completed","usage":{"input_tokens":18124,"cached_input_tokens":11008,"cache_write_input_tokens":0,"output_tokens":7,"reasoning_output_tokens":0}}',
]
for ln in LINES_OK:
    local_stream._on_line(REF, ln, term)

run = _RUNS[REF]
chk("★thread.started 抓到会话 id（续跑的唯一钥匙）",
    run.get("cliSid") == "00000000-0000-4000-8000-000000000001", run.get("cliSid"))
says = [x for x in run["lines"] if x.get("kind") == "say"]
chk("★agent_message 进实况（它说的话）",
    len(says) == 1 and says[0]["text"] == "SODUWORK_AGENT_OK", says)
steps = [x for x in run["lines"] if x.get("kind") == "step"]
chk("turn.started 补步骤心跳（想的时候不黑屏）", len(steps) == 1, run["lines"])
warns = [x for x in run["lines"] if x.get("kind") == "out" and x.get("tool") == "提示"]
chk("item.type=error 是过程提示：进实况但不置终态失败",
    len(warns) == 1 and not term.get("isError"), (warns, term))
tok = run.get("tokens") or {}
chk("Codex legacy turn.completed 累计 usage 不冒充上下文水位",
    not tok, tok)
chk("turn.completed 留下权威完成标记（父进程退出后管道被子进程占用也不误判）",
    run.get("turnCompleted") is True and term.get("completed") is True, (run, term))
usage = run.get("usage") or {}
chk("Codex 缓存输入作为 input_tokens 子集保留拆分但不重复计数",
    usage.get("input") == 18124 and usage.get("cacheRead") == 11008
    and usage.get("output") == 7 and usage.get("total") == 18131
    and usage.get("inputIncludesCache") is True, usage)

# Parse connection-failure events.
REF2 = "codex-smoke-fail"
_RUNS[REF2] = {"ref": REF2, "state": "running", "cli": "codex", "seq": 0, "segment": 1,
               "lines": [], "cfg": {}}
term2: dict = {}
LINES_FAIL = [
    '{"type":"thread.started","thread_id":"00000000-0000-4000-8000-000000000002"}',
    '{"type":"turn.started"}',
    '{"type":"error","message":"Reconnecting... 1/5 (stream disconnected before completion: error sending request for url (https://x/v1/responses))"}',
    '{"type":"turn.failed","error":{"message":"stream disconnected before completion: error sending request for url (https://x/v1/responses)"}}',
]
for ln in LINES_FAIL[:-1]:
    local_stream._on_line(REF2, ln, term2)
chk("顶层重连事件只进诊断日志，不污染用户对话，也不置终态",
    not any(x.get("tool") == "错误" for x in _RUNS[REF2]["lines"])
    and not term2.get("isError"), (_RUNS[REF2]["lines"], term2))
local_stream._on_line(REF2, LINES_FAIL[-1], term2)
chk("★turn.failed 才是终态失败（isError + 它自己报的那句）",
    term2.get("isError") and "stream disconnected" in str(term2.get("result") or ""), term2)

# Verify installation metadata and detection shape.
spec = agent_setup._SPECS.get("codex") or {}
chk("装机档案：pkg=@openai/codex（认准官方包名）", spec.get("pkg") == "@openai/codex", spec)
with (
    patch.object(agent_setup, "_bin_of", return_value=binp) as binary,
    patch.object(agent_setup, "_version_of", return_value=("0.147.0", "pkg", "")),
    patch.object(agent_setup, "_npm_root", return_value=SMOKE_DATA),
    patch.object(agent_setup, "_package_files", return_value=[]),
    patch.object(agent_setup.agent_npm_runtime, "package_engine", return_value=""),
    patch.object(agent_setup, "node_env", return_value={}),
    patch.object(codex_account_acp, "runtime_issue", return_value="") as adapter,
    patch.object(agent_setup, "_cached_version_probe", return_value="0.147.0") as version,
    patch.object(cli_account_auth, "_run", return_value=(1, "Not logged in")) as login,
):
    det = agent_setup.detect("codex", has_model=False, probes={})
    chk("已安装但未登录不能宣称可派活",
        det["installed"] and det["state"] == "unauthed" and det["auth"] == "unauthed", det)
    login.return_value = (0, "Logged in using ChatGPT")
    det = agent_setup.detect("codex", has_model=False, probes={})
    chk("CLI 确认已登录才 ready，不依赖共享模型",
        det["installed"] and det["state"] == "ready" and det["auth"] == "authed", det)
    chk("探测向界面提示 Responses API 要求", "Responses" in (det.get("warn") or ""), det)
    adapter.return_value = "Codex 缺少安全权限适配器，请更新后重试"
    det = agent_setup.detect("codex", has_model=False, probes={})
    chk("已登录但缺少权限适配器仍不可派活",
        not det["installed"] and det["state"] == "missing" and "适配器" in det["why"], det)
    adapter.return_value = ""
    version.return_value = ""
    det = agent_setup.detect("codex", has_model=False, probes={})
    chk("原生版本自检失败不能宣称已安装可用", not det["installed"] and det["state"] == "missing", det)
    binary.return_value = ""
    det = agent_setup.detect("codex", has_model=False, probes={})
    chk("未安装时明确 missing", not det["installed"] and det["state"] == "missing", det)

_RUNS.pop(REF, None)
_RUNS.pop(REF2, None)
shutil.rmtree(SMOKE_DATA, ignore_errors=True)
print(f"\n{ok} PASS / {fail} FAIL")
sys.exit(1 if fail else 0)
