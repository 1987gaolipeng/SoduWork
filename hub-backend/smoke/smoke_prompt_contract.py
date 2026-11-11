# -*- coding: utf-8 -*-
"""Regression checks for public module contracts."""
import os
import sys
from types import SimpleNamespace

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///.smoke-promptc.db")
sys.path.insert(0, ".")

from app.services import ai_local  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


t = SimpleNamespace(id="t-pc", title="页脚显示版本信息", note="小字灰色")
ctx = {
    "brief": "把版本信息放到页脚",
    "pluginNodeName": "形成需求基线",
    "deliveryMode": "files",
    "expectedOutputs": [
        {"key": "requirements", "kind": "file", "label": "需求基线 requirements.md",
         "path": "requirements.md", "required": True},
        {"key": "extra", "kind": "evidence", "label": "过程说明", "required": False},
    ],
}
p = ai_local._compose(t, ctx)
chk("提示词里有确切文件名", "`requirements.md`" in p, p[-400:])
chk("说死了一字不差", "一字不差" in p)
chk("把常见跑偏点名了（改名/加后缀/子目录）", "加前后缀" in p and "子目录" in p)
chk("文件项带「就用这个文件名」", "就用这个文件名" in p)
chk("evidence 项不带文件名措辞", "过程说明：`" not in p)
chk("节点边界仍在（不提前干后续节点）", "不要提前执行后续节点" in p)
chk("★派活正文先要求沿用任务语言，并保留代码和报错原文",
    p.strip().startswith("【用任务的语言说话】") and "中文任务写中文、日语任务写日语" in p
    and "代码、命令、报错原文照原样" in p)
chk("files 模式仍禁改源码", "不修改项目源码" in p)

chat = ai_local._compose(SimpleNamespace(id="chat-pc", title="为什么会这样", note=(
    "【SoduWork 普通对话规则】\n不要把每条消息默认当成任务。\n\n"
    "【用户原话】\n为什么会这样？")), {
        "conversationMode": "adaptive", "deliveryMode": "files",
    })
chk("普通对话不再包装成任务", "【任务】" not in chat and "由 SoduWork 派发" not in chat, chat)
chk("普通对话不再强制写文件", "产出请直接写成文件" not in chat, chat)
chk("普通对话保留回答/执行边界", "普通咨询直接用自然语言回答" in chat, chat)


rework = ai_local._compose(t, {
    "deliveryMode": "git",
    "repo": {"path": "/runner-work/current", "gitUrl": "https://git/repo.git",
             "branch": "main", "flow": False},
    "codeContinuation": {
        "commit": "a" * 40, "branch": "fix/t-pc", "target": "main",
    },
})
chk("返工明确锁定上一轮固定提交和同一远端任务分支",
    ("a" * 40) in rework and "fix/t-pc" in rework)
chk("返工只允许在当前隔离目录续做，不会串进旧工作树",
    "只在当前目录继续" in rework and "不要进入其他 `.soduwork/worktrees`" in rework)
chk("detached 返工使用非强推更新原分支且无需改动时不制造空提交",
    "git push origin HEAD:fix/t-pc" in rework and "不要制造空提交" in rework)

print("\nprompt contract smoke: %d passed, %d failed" % (ok, fail))
sys.exit(1 if fail else 0)
