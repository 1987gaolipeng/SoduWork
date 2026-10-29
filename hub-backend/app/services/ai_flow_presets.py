"""Development-flow presets, separate from rendering and validation. Presets override only relevant
settings; omitted values inherit defaults. Step text supports base, work, task, selftest,
evidence, and target placeholders.
"""
from __future__ import annotations

# Built-in development-flow steps.
# Use these steps when none are configured, preserving default behavior.
DEFAULT_STEPS: list[dict] = [
    {"key": "branch", "title": "拉取最新并切出工作分支", "detail":
     "先把远端拉到最新：`git fetch origin`，然后**从最新的远端基线**切出工作分支：\n"
     "`git checkout -B {work} origin/{base}`（分支名照抄，别自己起名）。\n"
     "★**必须从 `origin/{base}` 切，不要从本地 `{base}`**——工作目录是常驻的，本地基线\n"
     "多半停在上一轮；别人刚合进去的代码不拉下来，你就是在旧代码上开工，\n"
     "改动可能重复、合并时全是冲突（真机撞过）。\n"
     "★**就算工程当前已经在别的分支上，也要切到这个分支**——那多半是别的任务留下的，\n"
     "把这一条的提交混进去，后面按任务号找分支的自动合并就再也找不到它了。\n"
     "工作区如果是脏的，先报告再动手，别把别人的改动卷进来。\n"
     "切完先读一眼工程根的 `.soduwork/progress.md`（可能没有）：那是此前各轮改动留下的\n"
     "业务脉络，接着别人的思路干，别推倒重来。"},
    {"key": "code", "title": "改代码", "detail": "改动要小而完整，只解决这一件事。"},
    {"key": "selftest", "title": "自测", "detail": "{selftest}**把命令和输出留在回复里**。"},
    {"key": "evidence", "title": "自证", "detail": "{evidence}"},
    {"key": "memory", "title": "更新项目进展记忆", "detail":
     "把这一轮的进展**追加**到工程根的 `.soduwork/progress.md`（没有就连同 `.soduwork/` 目录一起建）：\n"
     "新起一小节，写清——日期与任务号 {task}、做了什么（一两句）、关键决定与为什么、\n"
     "动了哪些主要文件、没做完或需要接手的人知道的事。\n"
     "★这份文件是给**下一个接手的人或 AI**（可能在别的机器、别的云端拉了代码续做）看的\n"
     "业务地图：写事实和脉络，别写口号；**随本次提交一起进版本库**。"},
    {"key": "commit", "title": "提交并推送", "detail":
     "自检没问题再 `git add`/`git commit`（记得带上 `.soduwork/progress.md`），**push 到 `{work}`**。\n"
     "{commit}⚠️ 绝不 push 到 `{base}`，绝不 force push。\n"
     "★**这一步不是可选的**：改完不提交＝这活没交付。构建过了也一样要提交。"},
    {"key": "report", "title": "回复要点", "detail":
     "回复里给出：分支名、提交号、改了哪些文件、怎么验的、以及 MR/合并请求链接（如果建了）。"},
]

# Insert the merge-request step after commit and push only when mr is enabled.
# Do not include an empty merge-request step for workflows that do not use one.
MR_STEP = {"key": "mr", "title": "提交合并请求（MR/PR）", "detail":
           "把 `{work}` 向 `{target}` 提一个合并请求，标题写清做了什么、正文带上 SoduWork 任务号 {task}。\n"
           "★**只提请求、不要自己合**——合进目标分支是 SoduWork（或评审人）的事。\n"
           "把 MR 链接写进回复。"}

PRESETS: list[dict] = [
    {
        "id": "soduwork",
        "name": "SoduWork 默认",
        "desc": "分支 → 改 → 自测 → 自证 → 提交 push；合并交给 SoduWork。适合内网 GitLab、以 SoduWork 判交付。",
        "cfg": {"branch": "fix/{task}", "mr": "none", "commit": "", "steps": []},
    },
    {
        "id": "gitlab-flow",
        "name": "GitLab Flow（MR 到 develop）",
        "desc": "feature 分支 → MR 到 develop → 评审合入。AI 只负责提 MR。",
        "cfg": {"branch": "feature/{task}", "mr": "create", "mrTarget": "develop",
                "commit": "提交信息用任务描述的语言，写清做了什么 + 怎么验的。", "steps": []},
    },
    {
        "id": "github-flow",
        "name": "GitHub Flow（PR 到 main）",
        "desc": "短分支 → PR 到 main → CI 绿灯后合。提交信息用 Conventional Commits。",
        "cfg": {"branch": "{task}", "mr": "required", "mrTarget": "main",
                "commit": "提交信息按 Conventional Commits：`type(scope): summary`"
                          "（type 取 feat/fix/docs/refactor/test/chore 之一），正文里附上任务号 {task}。",
                "steps": []},
    },
    {
        "id": "jira-style",
        "name": "带工单号（Jira 式）",
        "desc": "分支名与提交信息都必须带工单号；改动要能追溯到需求。",
        "cfg": {"branch": "feature/{task}", "mr": "create",
                "commit": "提交信息首行必须以工单号开头：`[{task}] 做了什么`；"
                          "正文里写清改动范围与验证方式。", "steps": []},
    },
    {
        "id": "review-strict",
        "name": "严格评审（先自查清单）",
        "desc": "提交前必须逐条自查（影响面/回滚/日志/安全），再提 MR 等人评审。",
        "cfg": {
            "branch": "feature/{task}", "mr": "required",
            "steps": DEFAULT_STEPS[:4] + [
                {"key": "checklist", "title": "提交前自查（逐条回答，不许略过）", "detail":
                 "① 影响面：这次改动还会影响哪些页面/接口？② 回滚：出问题怎么退回去？\n"
                 "③ 日志与报错：异常路径有没有能定位问题的信息？④ 安全：有没有把凭据/个人信息写进代码或日志？\n"
                 "把四条的答案写在回复里——答不上来的先别提交。"},
            ] + DEFAULT_STEPS[4:],
        },
    },
    {
        "id": "docs-first",
        "name": "改动要留文档",
        "desc": "适合对外接口/协议类工程：改完必须同步更新文档与变更记录。",
        "cfg": {
            "steps": DEFAULT_STEPS[:4] + [
                {"key": "docs", "title": "同步文档", "detail":
                 "把这次改动同步进工程里的接口文档/README/CHANGELOG（工程里有哪个就更哪个），\n"
                 "**和代码放在同一个提交里**——分开提交会让评审看不到改动的全貌。"},
            ] + DEFAULT_STEPS[4:],
        },
    },
]


def by_id(pid: str) -> dict | None:
    return next((p for p in PRESETS if p["id"] == pid), None)
