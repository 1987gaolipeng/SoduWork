"""Executor-independent planning, milestone instructions, and tolerant plan parsing."""
from __future__ import annotations

import re


PROGRESS_FILE_RULE = """
【必须维护 `进度.md`（这条最重要）】
在工作目录根下维护一个 `进度.md`：里程碑清单（做完的打勾）、本轮改了什么、
下一轮从哪接着做、踩到的坑与结论。**每轮开工先读它，收工前更新它。**
原因说清楚：你这边的会话可能因为上下文超限被换成一个**全新会话**——
那时工作目录还在，但你的记忆没了。`进度.md` 是你唯一能跨轮记住事情的地方。
⚠️ 它是**给你自己用的工作产物、不是这个项目的代码**：`git add` 时别把它提交进去
（真机上它被当代码提交进了仓库，还跟着合并进了发版分支）。截图、日志同理。
"""

PLAN_RULE = """【本轮只做一件事：出计划，不要写代码】
把这件事拆成 3~8 个里程碑，每个都要小到能在一轮里做完、并且能当场自证做完了。
这一轮**不要改代码、不要建分支、不要提交**——产出就是这份计划本身。

按下面的格式回（字段名照抄，一个里程碑一段，别加额外装饰）：

### 里程碑 1
标题：一句话说清这一步交付什么
验收：怎么算做完了——要可执行或可观察（跑哪条命令看到什么、打开哪个页面看到什么）
工程：在哪个工程/目录上做；只有一个工程就写 -
可并行：是 / 否（只有当它和别的里程碑改的是**不同工程目录**时才写「是」）

### 里程碑 2
……

拆解原则：
- 每个里程碑都要能**单独验收**，别出现「第 3 步做完才知道第 2 步对不对」。
- 最能暴露风险的放最前（接口通不通、依赖装不装得上），别把硬骨头留到最后。
- 拿不准的写进最后的「要确认的问题」一节，**别自己替人做主**。
"""

PLAN_DELIVER = ("\n\n交付方式：把计划直接写在**回复正文**里就行，"
                "这一轮不用传附件、不用给地址。")


def plan_headline() -> str:
    return PLAN_RULE + PROGRESS_FILE_RULE


def milestone_brief(m: dict, idx: int, total: int, repo: dict | None = None,
                    task_id: str = "") -> str:
    """Build one milestone's instructions, reiterating workspace and branch constraints."""
    title = str(m.get("title") or "").strip()
    accept = str(m.get("accept") or "").strip()
    lines = [
        "【本轮口径 · 以本条为准，覆盖此前关于「这轮做什么」的任何说法】",
        f"这是第 {idx}/{total} 个里程碑，本轮**只做这一个**：{title}",
    ]
    if accept:
        lines.append(f"验收标准：{accept}")
    if repo and repo.get("path"):
        lines.append(f"在这个目录里做：{repo['path']}"
                     + (f"（工程：{repo.get('name')}）" if repo.get("name") else ""))
    if repo and repo.get("flow") and task_id:
        from . import ai_prompts
        wb = ai_prompts.work_branch(task_id, repo.get("devFlow"))
        base = repo.get("branch") or "main"
        lines += [
            "",
            f"【分支纪律 · 每轮都适用】动手前先 `git fetch`，确认自己在 **`{wb}`** 上"
            f"（没有就从 `{base}` 切出来）。★**就算工作目录现在在别的分支上也要切过去**——"
            "那多半是上一条任务留下的，把这一条的提交混进去，按任务号找分支的自动合并就再也找不到它。",
            f"提交后 **push 到 `{wb}`**。⚠️ **绝不** push 到基线分支"
            f"（{'、'.join('`%s`' % b for b in dict.fromkeys([base, 'main', 'develop', 'master']))}），"
            "**绝不**自己执行合并（`git merge` 到基线分支）——合并与发布是 SoduWork 做的，"
            "你只负责把自己的分支推上去。⚠️ 绝不 force push。",
        ]
    lines += [
        "",
        "做完**这一个**就停下来回复，别顺手把后面的里程碑一起做了——后面几轮我会再叫你。"
        "顺手多做的部分没人验收，出了问题也说不清是哪一步引入的。",
        "回复里请写清：改了哪些文件、怎么验的（命令与输出）、对照验收标准算不算过。",
        PROGRESS_FILE_RULE.strip(),
    ]
    return "\n".join(lines)


_MS_HEAD = re.compile(r"^\s{0,3}#{1,4}\s*里程碑\s*[:：]?\s*(\d+)?", re.M)


def _field(names: str) -> re.Pattern:
    return re.compile(r"^[*\-\s]*(?:" + names + r")[*`\s]*[:：]\s*(.+)$", re.M)


_MS_FIELD = {
    "title": _field("标题|里程碑|名称"),
    "accept": _field("验收标准|验收|完成标准"),
    "repo": _field("工程|目录|仓库"),
    "par": _field("可并行|并行"),
}


def _clean(s: str) -> str:
    return re.sub(r"[*`]+", "", (s or "")).strip()


def parse_plan(text: str) -> list[dict]:
    """Parse an AI plan into milestones; return empty for unsupported formats without blocking
    manual planning.
    """
    text = text or ""
    blocks: list[str] = []
    heads = list(_MS_HEAD.finditer(text))
    if heads:
        for i, head in enumerate(heads):
            end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
            blocks.append(text[head.end():end])
    else:
        if "里程碑" not in text and "验收" not in text:
            return []
        items = re.split(r"^\s{0,3}(\d{1,2})[.、)]\s+", text, flags=re.M)[1:]
        blocks = [items[i + 1] for i in range(0, len(items) - 1, 2)]

    out: list[dict] = []
    for block in blocks:
        title = _clean(m.group(1)) if (m := _MS_FIELD["title"].search(block)) else ""
        if not title:
            title = next((_clean(line) for line in block.splitlines() if _clean(line)), "")
        if not title:
            continue
        par = _clean(m.group(1)) if (m := _MS_FIELD["par"].search(block)) else ""
        repo = _clean(m.group(1)) if (m := _MS_FIELD["repo"].search(block)) else ""
        out.append({
            "title": title[:300],
            "accept": (_clean(m.group(1))[:2000]
                       if (m := _MS_FIELD["accept"].search(block)) else ""),
            "repo": "" if repo in ("-", "—", "无") else repo[:200],
            "parallelOk": par.startswith(("是", "可", "y", "Y", "t", "T")),
        })
    return out[:20]
