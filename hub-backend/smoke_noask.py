# -*- coding: utf-8 -*-
"""Regression checks for public module contracts."""
import io
import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, ".")

SMOKE_DATA = os.path.abspath(".smoke-noask-data")
shutil.rmtree(SMOKE_DATA, ignore_errors=True)
os.environ["SODUWORK_DATA_ROOT"] = SMOKE_DATA

from types import SimpleNamespace  # noqa: E402
from app.services import ai_local, ai_prompts, local_stream  # noqa: E402
from app.services.local_base import _PROFILES, _env_for  # noqa: E402

ok = fail = 0
log = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        log.append("  PASS  " + name)
    else:
        fail += 1
        log.append("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


def says(text):
    """Build a realistic run with structured activity; only the final say event determines
    clarification detection.
    """
    return {"lines": [{"kind": "step", "text": "第 1 步"},
                      {"kind": "do", "tool": "write", "text": "写了个文件"},
                      {"kind": "say", "text": text}]}


# Verify prompt instructions.
body = ai_prompts.dev_flow({}, {})
chk("★派活正文里带上了「不许反问」这一段", "不许反问" in body, body[:200])
for k in ("自己挑一个最合理的做法", "还需要人处理", "不能是一个问句"):
    chk("话术里有「%s」这条" % k, k in body)
chk("★这段话住在 ai_prompts（两个 adapter 共用，不能只在某一个 adapter 里写）",
    "不许反问" in ai_prompts.NO_ASK)

task_prompt = ai_local._compose(SimpleNamespace(
    id="t-action", title="创建验收文件", note="生成 result.txt"), {
        "expectedOutputs": [{"key": "result", "label": "产出物"}],
        "pluginNodeName": "AI 干活", "deliveryMode": "files"})
chk("任务提示要求真实调用工具，不能只承诺将要执行",
    "必须实际调用可用工具完成并核验真实结果" in task_prompt, task_prompt)
chk("工作流节点提示把只复述要求判为未交付",
    "复述要求，不算交付" in task_prompt, task_prompt)
chat_prompt = ai_local._compose(SimpleNamespace(
    id="", title="", note="解释什么是 ACP"), {"conversationMode": "adaptive"})
chk("普通咨询不被任务执行约束强迫调用工具",
    "必须实际调用可用工具完成" not in chat_prompt, chat_prompt)
# Verify Pi tool-exclusion arguments.
args = _PROFILES["pi"]["start"]("sid-1", "work", "C:/tmp", {"llm": {"model": "m"}})
chk("★pi 的命令行上关掉了「问人」那个工具",
    "--exclude-tools" in args and "ask_question" in args, args)
chk("pi 仍然是非交互模式（-p），别把这条改丢了", "-p" in args, args)
chk("信任工程内本地文件（--approve），否则技能会少加载", "--approve" in args, args)

approved_root = os.path.join(SMOKE_DATA, "approved")
oc_env = _env_for(_PROFILES["opencode"], {
    "local_workspace_root": approved_root,
    "llm": {"base": "https://model.example/v1", "key": "k", "model": "m"},
})
oc_permission = json.loads(oc_env["OPENCODE_CONFIG_CONTENT"])["permission"]
oc_external = dict(oc_permission.get("external_directory") or {})
chk("OpenCode 只放行用户授权工作根，不使用全局 auto 模式",
    oc_external.get("*") == "deny"
    and any(v == "allow" and "approved" in k for k, v in oc_external.items()), oc_external)
chk("OpenCode 无人值守时禁用反问与重复死循环提示",
    oc_permission.get("question") == "deny" and oc_permission.get("doom_loop") == "deny",
    oc_permission)

expected_temp = os.path.normcase(os.path.join(approved_root, "temp"))
chk("所有 CLI 的临时文件也留在用户授权工作根",
    all(os.path.normcase(oc_env.get(k) or "") == expected_temp for k in ("TEMP", "TMP", "TMPDIR")),
    {k: oc_env.get(k) for k in ("TEMP", "TMP", "TMPDIR")})

# Test clarification detection and non-question controls.
should_catch = [
    "我需要确认一下：是用 MySQL 还是 PostgreSQL？",
    "方案 A 和方案 B 都可行，您希望用哪个",
    "已经把骨架搭好了。要不要我接着把接口也实现了？",
    "请问这个字段是必填的吗",
    "先做到这儿，需要我继续吗",
    "请确认后我再继续",
]
for t in should_catch:
    chk("★认得出这是反问收尾：%s" % t[:22], local_stream._ends_with_question(says(t)), t)

should_not_catch = [
    "已完成并校验。产出：祁连山水泥工艺优化方案.html（37 KB），可直接双击打开。",
    "改完了，跑过测试全绿。我选了方案 A，因为它改动面最小；备选还有方案 B。",
    "还需要人处理：仓库缺少推送凭据，其余都做完了，代码在 fix/tms123 分支上。",
    "这里的问题在于旧接口没有分页，我加了 limit/offset 并补了测试。",
    "已经把「是否启用缓存」这个开关做成了配置项，默认关。",
]
for t in should_not_catch:
    chk("★★不许误判成反问：%s" % t[:22], not local_stream._ends_with_question(says(t)), t)

chk("没有任何 say 时不误判（比如整轮都没说话）", not local_stream._ends_with_question({"lines": []}))
chk("空文本不误判", not local_stream._ends_with_question(says("   ")))

# Verify the automatic continuation message.
a = local_stream._AUTO_ANSWER
chk("★自动答复里明说了这是 SoduWork 自动回的（不能让人以为是自己发的）", "SoduWork 自动回" in a, a[:80])
chk("自动答复要求它自己定并写清假设", "自己拿主意" in a and "假设" in a)
chk("自动答复要求结尾给可交付结果", "可交付的结果" in a)
chk("★界面话术里不许有 markdown 以外的乱码记号", "\\n" not in a)

# Exercise the actual settlement branch.
# Settlement is shared by every execution.
# Test the integration path as well as the detection helper.
# Replace only _resume with a recorder to avoid launching a process.
# This case verifies continuation decisions, while existing tests cover queued execution mechanics.
import os  # noqa: E402
import uuid  # noqa: E402

from app.services.local_base import _RUNS, _STORE  # noqa: E402

probe_ref = str(uuid.uuid4())
os.makedirs(os.path.join(_STORE, probe_ref), exist_ok=True)
_RUNS[probe_ref] = {"ref": probe_ref, "state": "running", "cli": "opencode",
                    "seq": 0, "segment": 1, "ws": ".", "taskId": "t-scope",
                    "lines": [], "cfg": {}}
local_stream._on_line(
    probe_ref,
    r"! permission requested: external_directory (C:\approved\repo\*); auto-rejecting",
    {}, stream="err")
probe = _RUNS.pop(probe_ref)
chk("目录权限拒绝被识别为可恢复的工作区阻断",
    probe.get("failureKind") == "workspace_permission"
    and probe.get("failurePath") == r"C:\approved\repo", probe)

resumed = []
_real_resume = local_stream._resume
local_stream._resume = lambda ref, text, cfg=None: resumed.append(text) or {"ok": True}
try:
    def _run_once(last_say, **extra):
        ref = str(uuid.uuid4())
        os.makedirs(os.path.join(_STORE, ref), exist_ok=True)
        runtime_cfg = extra.pop("cfg", {})
        workspace = extra.pop("ws", ".")
        run_lines = extra.pop("lines", says(last_say)["lines"])
        _RUNS[ref] = {"ref": ref, "state": "running", "cli": "pi", "seq": 3,
                      "segment": 1, "cfg": runtime_cfg, "ws": workspace, "taskId": "t-noask",
                      "lines": run_lines, **extra}
        local_stream._finish(ref, 0, {}, "")
        r = dict(_RUNS.pop(ref))
        return r

    resumed.clear()
    r = _run_once("方案 A 和方案 B 都可以，您希望用哪个？")
    chk("★★反问收尾 → 真的自动续了一轮", len(resumed) == 1, resumed)
    chk("★续的那句就是「你自己定」那段", resumed and "自己拿主意" in resumed[0])
    chk("★打了标记，不会再推第二次", r.get("autoAnswered") is True, r.get("autoAnswered"))
    chk("自动续跑交接期间不提前暴露 done，防止下游越过当前节点", r.get("state") == "recovering", r.get("state"))
    chk("★实况里留了痕（人得看得出这轮是 SoduWork 替他答的）",
        any("SoduWork 自动接管" in str(x.get("text", "")) for x in (r.get("lines") or [])),
        [x.get("kind") for x in (r.get("lines") or [])])

    resumed.clear()
    r = _run_once("已完成。产出在工作目录下的 report.html。",
                  cfg={"llm": {"key": "secret-model-key"}, "git": {"token": "secret-git"}})
    chk("★★正常收尾**不会**被自动续（误判的代价是白跑一轮）", not resumed, resumed)
    chk("正常收尾也不该打标记", not r.get("autoAnswered"))
    chk("★终态立即清掉执行期模型与代码凭据", r.get("cfg") == {}, r.get("cfg"))


    resumed.clear()
    r = _run_once("那要用哪个方案？", autoAnswered=True)
    chk("★★已经推过一次就不再推（避免它问、我们答、它再问的死循环）", not resumed, resumed)

    resumed.clear()
    r = _run_once("要不要我继续？", queue=["人自己排的话"])
    chk("★人自己排的话优先，别插队", resumed == ["人自己排的话"], resumed)

    resumed.clear()
    r = _run_once(
        "还在执行最后一步。", timedOut="静默 15 分钟没动静", cliSid="ses-smoke",
        cfg={"llm": {"base": "http://model.invalid", "key": "test-key", "model": "test-model"}})
    chk("★★静默超时会自动续跑同一会话一次", len(resumed) == 1, resumed)
    chk("自动恢复要求检查现状，不能重复已经完成的工作",
        resumed and "不要重复已经完成的工作" in resumed[0], resumed)
    chk("自动恢复有严格次数上限", r.get("stallRetries") == 1, r.get("stallRetries"))

    resumed.clear()
    r = _run_once("又一次没有响应。", timedOut="静默 15 分钟没动静",
                  cliSid="ses-smoke", stallRetries=1)
    chk("★★第二次静默不再无限重试", not resumed, resumed)
    chk("第二次静默明确进入可处理失败态",
        r.get("state") == "failed" and r.get("failureKind") == "execution_stalled", r)

    repo = os.path.join(SMOKE_DATA, "pending-git-work")
    os.makedirs(repo, exist_ok=True)
    subprocess.run(["git", "init", "-q", repo], check=True)
    with open(os.path.join(repo, "pending.py"), "w", encoding="utf-8") as f:
        f.write("print('real work')\n")
    broken_lines = says("I")["lines"]
    broken_lines.insert(-1, {
        "kind": "out", "tool": "edit",
        "text": 'Validation failed for tool "edit": Received arguments: {}',
    })
    resumed.clear()
    r = _run_once("I", ws=repo, lines=broken_lines, codeTask=True, artifactMode="git",
                  cfg={"llm": {"key": "secret-model-key"}})
    chk("★★Pi 工具参数异常且代码未提交时自动续跑同一会话", len(resumed) == 1, resumed)
    chk("自动恢复明确要求保留进度、测试、提交并推送",
        resumed and all(word in resumed[0] for word in ("保留", "测试", "提交", "推送")), resumed)
    chk("未完成恢复有严格一次上限", r.get("completionRetries") == 1, r)
    chk("自动恢复在人可见实况中留下简短说明",
        any("SoduWork 自动恢复" in str(x.get("text", "")) for x in (r.get("lines") or [])), r)

    resumed.clear()
    r = _run_once("I", ws=repo, lines=broken_lines, codeTask=True, artifactMode="git",
                  completionRetries=1)
    chk("★★同一未完成状态不会无限续跑", not resumed, resumed)

    resumed.clear()
    r = _run_once("已完成实现与验证，提交和远端分支信息见交付回执。",
                  ws=repo, codeTask=True, artifactMode="git")
    chk("正常完整的 Git 结果即使门禁后续会拦截，也不由异常恢复器误续跑", not resumed, resumed)

    resumed.clear()
    r = _run_once("I", ws=repo, lines=broken_lines)
    chk("异常短回复不会误伤普通对话", not resumed, resumed)
finally:
    local_stream._resume = _real_resume
    shutil.rmtree(SMOKE_DATA, ignore_errors=True)

log.append("")
log.append("PASS=%d FAIL=%d" % (ok, fail))
with io.open("smoke_noask.out.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(log))
print("PASS=%d FAIL=%d" % (ok, fail))
sys.exit(1 if fail else 0)
