"""Shared task execution policy and configurable workflow defaults."""
from __future__ import annotations

from .ai_flow_presets import DEFAULT_STEPS, MR_STEP

# Configurable development-flow fields.
# Merge global dev_flow_default settings with repository dev_flow overrides.
# This module defines shapes and defaults; APIs persist and inject configuration.
DEFAULTS: dict = {
    # Branch templates must contain {task}.
    # git_ops identifies candidate remote branches by task ID.
    # normalize validates the placeholder so automated delivery can identify the branch.
    "branch": "fix/{task}",
    # An empty commit convention uses the task language and describes the change and verification.
    # Projects may require Conventional Commits or a ticket reference.
    "commit": "",
    # Merge request modes: none, create, or required with review details.
    # Creating a merge request never authorizes the agent to merge into the baseline.
    "mr": "none",
    # The merge-request target defaults to merge_branch, then the baseline branch.
    "mrTarget": "",
    # Use an explicit verification command when configured.
    # Otherwise request the project's existing tests and build.
    "selftest": "",
    # Screenshot modes: auto for UI changes, always for all changes.
    # never forbids GUI browsers and uses builds, artifact inspection, and HTTP checks instead.
    # The never option supports environments where GUI preview capture can hang.
    # Keep that choice configurable rather than requiring source changes.
    "screenshot": "auto",
    # An empty step list inherits DEFAULT_STEPS.
    # Each step has key, title, and detail; detail supports base, work, task, selftest, evidence, commit, and target placeholders.
    "steps": [],
    # Append project-specific rules unchanged at the end of the flow.
    "extra": "",
}

_SHOT_CHOICES = ("auto", "always", "never")
_MR_CHOICES = ("none", "create", "required")
_STEP_CAP = 20              # Bound the number of steps to keep instructions manageable.


def normalize(cfg: dict | None, base: dict | None = None) -> dict:
    """Normalize configuration against the preceding defaults. Empty values inherit defaults,
    except extra, which may explicitly be cleared.
    """
    out = dict(DEFAULTS)
    out.update({k: v for k, v in (base or {}).items() if k in DEFAULTS})
    for k, v in (cfg or {}).items():
        if k not in DEFAULTS:
            continue
        if k == "steps":
            if v:                       # An empty list inherits the default.
                out[k] = v
            continue
        if k != "extra" and not str(v or "").strip():
            continue                    # Empty values inherit rather than overwrite defaults.
        out[k] = v
    out["branch"] = _safe_branch_tpl(out["branch"])
    out["commit"] = str(out["commit"] or "").strip()[:600]
    out["mr"] = out["mr"] if out["mr"] in _MR_CHOICES else "none"
    out["mrTarget"] = _safe_branch_name(out["mrTarget"])
    out["selftest"] = str(out["selftest"] or "").strip()[:400]
    out["screenshot"] = out["screenshot"] if out["screenshot"] in _SHOT_CHOICES else "auto"
    out["steps"] = _clean_steps(out["steps"])
    out["extra"] = str(out["extra"] or "").strip()[:2000]
    return out


def _clean_steps(steps) -> list:
    """Normalize titled steps, bound their length, and discard malformed entries without failing
    dispatch.
    """
    if not isinstance(steps, list):
        return []
    out = []
    for i, s in enumerate(steps[:_STEP_CAP]):
        if not isinstance(s, dict):
            continue
        title = str(s.get("title") or "").strip()[:80]
        if not title:
            continue
        out.append({"key": str(s.get("key") or ("s%d" % i))[:24],
                    "title": title,
                    "detail": str(s.get("detail") or "").strip()[:1500]})
    return out


def _safe_branch_name(name: str) -> str:
    n = str(name or "").strip()
    bad = set(" ~^:?*[\\")
    if not n or any(c in n for c in bad) or ".." in n or n.startswith("/") or n.endswith("/"):
        return ""
    return n[:120]


def _safe_branch_tpl(tpl: str) -> str:
    """Require a task placeholder and valid Git branch characters. Invalid templates fall back to
    the default during dispatch; administration validates them on save.
    """
    tpl = str(tpl or "").strip()
    if "{task}" not in tpl:
        return DEFAULTS["branch"]
    if not _safe_branch_name(tpl.replace("{task}", "x")):
        return DEFAULTS["branch"]
    return tpl[:120]


def check(cfg: dict) -> str:
    """Validate before saving; return empty on success or a user-facing error message."""
    c = cfg or {}
    tpl = str(c.get("branch") or "").strip()
    if tpl:
        if "{task}" not in tpl:
            return "分支模板里必须有 {task}（SoduWork 任务号）——自动合并就是靠名字里的任务号认分支的，少了它这条提交永远合不进去。"
        if _safe_branch_tpl(tpl) != tpl:
            return "分支模板里有 git 不允许的字符（空格 ~ ^ : ? * [ \\ .. 或首尾的 /）。"
    if c.get("mrTarget") and not _safe_branch_name(c["mrTarget"]):
        return "MR 目标分支名里有 git 不允许的字符。"
    if c.get("screenshot") and c["screenshot"] not in _SHOT_CHOICES:
        return "截图要求只能是 auto / always / never。"
    if c.get("mr") and c["mr"] not in _MR_CHOICES:
        return "「建不建合并请求」只能是 none / create / required。"
    steps = c.get("steps")
    if steps is not None:
        if not isinstance(steps, list):
            return "步骤必须是一个列表。"
        if len(steps) > _STEP_CAP:
            return "步骤最多 %d 步——再多就不是流程而是说明书了，AI 也照不下来。" % _STEP_CAP
        if steps and not _clean_steps(steps):
            return "每一步都要填标题。"
        for s in _clean_steps(steps):
            if not s["detail"]:
                return "「%s」这一步还没写要求——只有标题的话 AI 不知道要干什么。" % s["title"]
    return ""


# Execution environment.
# Render command examples for the actual executor's environment.
# Detect the local platform rather than hard-coding PowerShell commands.
# When the remote platform is unknown, provide applicable alternatives.
def detect_env() -> dict:
    """Detect the local executor's operating system and default shell."""
    import platform
    sysname = (platform.system() or "").lower()
    if sysname.startswith("win"):
        return {"os": "windows", "shell": "powershell"}
    if sysname == "darwin":
        return {"os": "macos", "shell": "zsh"}
    return {"os": "linux", "shell": "bash"}


def _bg_cmd(env: dict | None) -> str:
    if not env:
        return "Windows/PowerShell 用 `Start-Process`；bash/zsh 用 `nohup ... &`"
    return {"powershell": "`Start-Process`", "zsh": "`nohup ... &`"}.get(
        env.get("shell", ""), "`nohup ... &`")


def _grep_cmd(env: dict | None) -> str:
    if not env or env.get("shell") == "powershell":
        return "`Select-String -Path dist/assets/*.js -Pattern \"你新增的文案\"`（PowerShell）"
    return "`grep -r \"你新增的文案\" dist/assets/`"


def _env_notes(env: dict | None) -> str:
    """Return environment-specific guidance only when it applies to this executor."""
    if env and env.get("shell") != "powershell":
        return ""
    return (
        "\n⚠️ **PowerShell 上别用可能挂住的管道**："
        "`Get-Content x | Select-String … | Select-Object -First N` 这种写法会卡住不返回"
        "（真撞过，整轮被静默超时砍掉）。看片段用 `Get-Content x -TotalCount N` / `-Tail N`，"
        "搜用 `findstr` 或 `Select-String -Path x -Pattern y`（**直接给 -Path，别用管道**）。\n"
    )


# Prompt body sections.

# Specify the response-language policy explicitly rather than relying on a model's default.
# Match the language of the task description unless the task requests another output language.
# Preserve original code, commands, and error messages rather than translating them.
LANG_RULE = ("【用任务的语言说话】过程说明、计划、每一步在做什么、交付说明，一律用这条任务描述所用的语言写"
             "（中文任务写中文、日语任务写日语）——看这条会话的是提出任务的同事，不是在读英文日志。"
             "代码、命令、报错原文照原样；任务明确要求其他语言的产出除外。")

HEAD = "\n【按研发流程走（重要）】\n"

# Always include the shared safety constraints, regardless of optional configuration.
REDLINES = """
⚠️ **你的活到"把自己的改动推上去{mr_tail}"就结束了**。以下三件**一件都不许做**（真机上出过事：
它自己合了 main、还 SFTP 传到生产机 `systemctl restart` 把服务重启了——备份和健康检查它都做了，
可整件事在 SoduWork 的视野之外，没人授权、没有留痕、出事没法对账）：
- ✗ **自己合进基线分支**（`git merge` 到 main/develop/master 并推上去）——合并是 SoduWork（或评审人）做的；
- ✗ **发布上线**：不许连生产/测试服务器（ssh/scp/sftp/rsync）、不许改服务器上的文件、
  不许 `systemctl` / 重启任何服务、不许动数据库；
- ✗ force push、改已推历史。
需要上线就在回复里说明"这条改动可以发布了"，由 SoduWork 按管理员配好的发布目标触发。
"""

BROWSER_RULE = """
⚠️ **要用浏览器截图验证时，端口和用户目录都必须是你自己的**：
拉浏览器一律用**随机高位端口**（别用 9222/9229 这些默认口）+ 独立的 `--user-data-dir`；
连上 CDP 后**先核对 target 的 URL 是不是你自己要开的那个页面**，不是就断开重来。
原因：开发机上常有别的应用（比如 SoduWork 桌宠自己）正占着 9222，你的浏览器绑不上这个端口时，
脚本会**连到那个应用上**，然后一个 `Page.navigate` 把人家的窗口开到你的页面去——真出过这事。
"""


# Unattended execution cannot depend on an interactive user response.
# Ending with a clarification question can leave the requested output incomplete.
# Make reasonable assumptions, finish the task, and disclose the assumptions in the result.
NO_ASK = """
⚠️ **不许反问，也不许停下来等确认——把活干完再说话。**
这是无人值守的派活：你问出来的问题当场没有人看，这一轮就废了。
- 信息不足 → **自己挑一个最合理的做法做下去**，别问"要不要"、"用哪个"、"是否继续"。
- 有多个可行方案 → **选一个做完**，在交付说明里写"我选了 X，因为 Y；备选还有 Z"。
- 需求有歧义 → 按**最常见、最保守**的那种理解做，并把你的理解写在开头一句。
- 真有拦路的前提（缺凭据/缺依赖/目录不存在）→ 不要问，**照样把能做的做完**，
  然后在结尾用「**还需要人处理**」起头，一条条列清楚卡在哪、需要谁做什么。
- ★**结尾必须是可交付的结果**（做了什么、东西在哪），**不能是一个问句**。
你的所有假设都会被人看到，写清楚就不算擅自决定；停下来问才是真的把事情耽误了。
"""

LONG_RUN = """
⚠️ **别在前台跑长驻命令**（`npm run dev`、`uvicorn`、`watch` 之类不会自己退出的）——
执行环境有静默看门狗（约 10 分钟没有新消息就把你掐掉，这条流程真的被掐过一次）。
要起服务就**后台起**（{bg}），隔几秒用 curl 探活，用完记得停掉。
耗时命令（安装/构建）也请拆开跑，每步之间说一句话，别闷头憋着。
"""

# Alternative wording for the verification step.
# Do not indent multiline prompt fragments here.
# dev_flow applies continuation indentation consistently for numbered steps.
SELFTEST_GENERIC = ("跑这个工程既有的测试/构建（README 或上面的「怎么跑/怎么测」里写了就照做）。\n"
                    "没有测试就自己起服务跑一遍关键路径。")
SELFTEST_FIXED = ("跑 `{cmd}`（这个工程配好的自测命令，必须通过）。\n"
                  "它跑不过就先修到过，别带着红的构建往下走。")

# Evidence instructions for auto, always, and never screenshot modes.
VERIFY_AUTO = "**截图验证**（界面类改动必须）：{artifact}\n没法截图的（纯后端）就贴关键请求/响应或测试输出。"
VERIFY_ALWAYS = ("**必须留下可看的证据**（这个工程要求每次改动都有）：{artifact}\n"
                 "纯后端改动也要留：贴出真实请求与响应，或者测试跑过的完整输出。")
VERIFY_NEVER = ("**不要启动 GUI 浏览器截图**（chrome/edge/puppeteer/playwright 一概不要）。"
                "改用这三步自证，把命令和输出贴在回复里：\n"
                "① 构建/测试必须通过；② 在**构建产物**里核对你改的东西真进去了（例如 {grep}）；"
                "③ 需要真跑就**后台起服务 + curl 探活**，拿到期望内容就**立刻停掉**。")

# Provider-specific screenshot and evidence delivery instructions.
ARTIFACT_HOSTED = "把改动后的界面截图存到工程目录下，作为**评论附件**交回。"
ARTIFACT_LOCAL = (
    "把改动后的界面截图存到工程目录下，SoduWork 会自己从这个目录把新文件收走。\n"
    "★截图/日志这类是**产出物、不是代码**：`git add` 的时候**只加你真正改的源码**，"
    "别把它们（和工作区里本来就有的其它未跟踪文件）一起提交进去。"
)

COMMIT_DEFAULT = "提交信息用任务描述的语言、写清做了什么+怎么验的。\n"

# Unattended autobatch instructions prohibit GUI browsers.
# GUI preview capture can stall without producing further output.
# Such stalls would otherwise wait for the execution timeout.
# Use unattended-safe evidence collection for autobatch.
UNATTENDED = """
【这一批是自动派的，没人盯着——自证方式换一套】
✗ **不要启动 GUI 浏览器截图**（chrome/edge/puppeteer/playwright 一概不要）。
  这台机器上拉浏览器会把这一轮挂死，然后等静默超时被砍，你的改动全白做。
✓ 界面类改动这样自证（三步都要，把命令和输出贴在回复里）：
  1. 构建/测试命令必须通过；
  2. 在**构建产物**里核对你改的东西真进去了；
  3. 需要真跑一下就**后台起服务 + curl 探活**，拿到 200/期望内容就**立刻停掉**服务；
     起不来别硬磕，把错误贴出来继续下一条。
"""


def work_branch(task_id: str, cfg: dict | None = None) -> str:
    """Build the task branch name from the configured template. Always include the SoduWork task ID
    so git_ops can identify its branch without guessing.
    """
    tid = "".join(c for c in str(task_id or "") if c.isalnum() or c in "-_") or "task"
    return normalize(cfg)["branch"].replace("{task}", tid)


def render_step(detail: str, vars_: dict) -> str:
    """Replace known step placeholders literally. Avoid str.format because administrator-authored
    text may contain unrelated braces, including JSON examples.
    """
    out = str(detail or "")
    for k, v in vars_.items():
        out = out.replace("{%s}" % k, str(v))
    return out


def dev_flow(branch: str, local: bool, task_id: str = "",
             cfg: dict | None = None, unattended: bool = False,
             env: dict | None = None, scm: str = "",
             gerrit_base: str = "") -> str:
    """Compose resolved development-flow instructions. branch is the protected baseline; task_id
    determines the work branch; cfg contains merged defaults and project overrides. local
    controls evidence delivery, unattended disables screenshots, and env selects compatible
    command examples.
    """
    from . import scm_support
    scm_support.require_active(scm)
    c = normalize(cfg)
    shot = "never" if unattended else c["screenshot"]
    base = branch or "main"
    work = work_branch(task_id, c)
    artifact = ARTIFACT_LOCAL if local else ARTIFACT_HOSTED
    verify = {"auto": VERIFY_AUTO, "always": VERIFY_ALWAYS, "never": VERIFY_NEVER}[shot]
    # First render placeholders in user-authored conventions and project rules.
    # Then insert those rendered fragments into the steps.
    # A single replacement pass would leave nested placeholders unresolved.
    slots = {"base": base, "work": work, "task": str(task_id or ""),
             "target": c["mrTarget"] or base}
    commit_rule = render_step(c["commit"], slots)
    vars_ = dict(slots)
    vars_.update({
        "selftest": (SELFTEST_FIXED.replace("{cmd}", c["selftest"]) if c["selftest"]
                     else SELFTEST_GENERIC),
        "evidence": verify.replace("{artifact}", artifact).replace("{grep}", _grep_cmd(env)),
        "commit": (commit_rule + "\n") if commit_rule else COMMIT_DEFAULT,
    })
    steps = list(c["steps"] or DEFAULT_STEPS)
    if c["mr"] != "none":
        # Insert the merge-request step after commit and push, or near the end of a custom flow.
        mr = dict(MR_STEP)
        if c["mr"] == "required":
            mr["detail"] += "\n★这个工程**必须**走合并请求，没有 MR 这活不算交完。"
        at = next((i for i, s in enumerate(steps) if s.get("key") == "commit"), len(steps) - 1)
        steps.insert(at + 1, mr)

    lines = [HEAD.rstrip("\n")]
    for i, s in enumerate(steps, 1):
        detail = render_step(s.get("detail") or "", vars_)
        # Indent continuation lines by three spaces to align with numbered steps.
        detail = detail.replace("\n", "\n   ")
        lines.append("%d. **%s**：%s" % (i, s.get("title") or "", detail))
    body = "\n".join(lines) + "\n"
    body += NO_ASK
    body += REDLINES.replace("{mr_tail}", "、提了合并请求" if c["mr"] != "none" else "")
    # Describe change-hygiene rules before execution so quality gates do not introduce unexpected requirements.
    # change_hygiene owns the shared wording.
    from . import optional_internal_features
    if optional_internal_features.available("change_hygiene"):
        from .change_hygiene import PROMPT as _HYGIENE
        body += "\n" + _HYGIENE + "\n"
    if shot != "never":
        body += BROWSER_RULE
    body += LONG_RUN.replace("{bg}", _bg_cmd(env))
    body += _env_notes(env)
    if c["extra"]:
        body += "\n【这个工程另外要求的（管理员配的，同样要照做）】\n" + render_step(c["extra"], slots) + "\n"
    return body


# Configuration persistence.
# Store global defaults in app_setting and project overrides in repo.dev_flow.
# Import models locally to preserve the adapters' dependency structure.
# models does not import services, so this table dependency introduces no cycle.
SETTING_KEY = "dev_flow_default"


async def load_default(session) -> dict:
    """Read administrator-defined global defaults, falling back to DEFAULTS. Avoid process caching
    so changes apply to the next dispatch.
    """
    import json as _json

    from .. import models
    row = await session.get(models.AppSetting, SETTING_KEY)
    if row is None or not (row.value or "").strip():
        return dict(DEFAULTS)
    try:
        return normalize(_json.loads(row.value))
    except Exception:      # noqa: BLE001 - Fall back to defaults if stored configuration is invalid.
        return dict(DEFAULTS)


async def save_default(session, cfg: dict) -> dict:
    import json as _json

    from .. import models
    merged = normalize(cfg)
    row = await session.get(models.AppSetting, SETTING_KEY)
    if row is None:
        row = models.AppSetting(key=SETTING_KEY, value="")
        session.add(row)
    row.value = _json.dumps(merged, ensure_ascii=False)
    return merged


async def resolve(session, repo=None) -> dict:
    """Resolve global defaults with project overrides before composing instructions. Reuse
    merge_branch as the default merge-request target.
    """
    base = await load_default(session)
    over = dict(getattr(repo, "dev_flow", None) or {}) if repo is not None else {}
    out = normalize(over, base=base)
    if not out["mrTarget"]:
        out["mrTarget"] = _safe_branch_name(getattr(repo, "merge_branch", "") or "")
    return out
