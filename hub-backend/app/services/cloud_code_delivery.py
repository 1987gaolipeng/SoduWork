"""Recognize an explicit code request without turning ordinary URLs into Git jobs."""
from __future__ import annotations

import re
from urllib.parse import urlsplit


def repository(text: str) -> str:
    text = str(text or "")
    # Questions, reviews and document exports do not authorize code changes.
    if re.search(r"(?:只|仅|不要|无需|不必).{0,8}(?:分析|解释|审查|修改|提交|推送)|\b(?:read.only|explain|analy[sz]e|review|summari[sz]e)\b", text, re.I):
        return ""
    if not re.search(r"修复|修正|改造|重构|实现|开发|修改.{0,12}(?:代码|工程|项目|功能)|\b(?:fix|implement|refactor|develop)\b", text, re.I):
        return ""
    candidates = re.findall(r"(?:https?://|ssh://|git@[A-Za-z0-9.-]+:)[^\s<>\"'`，。；（）)]+", text)
    found = []
    for raw in candidates:
        value = raw.rstrip(".,;!]")
        if value.startswith("git@"):
            valid = bool(re.fullmatch(r"git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+\.git", value))
        else:
            try:
                parsed = urlsplit(value)
                hostname = parsed.hostname
            except ValueError:
                continue
            parts = [part for part in parsed.path.split("/") if part]
            known_host = hostname in {"github.com", "gitlab.com", "bitbucket.org"}
            valid = (parsed.scheme in {"https", "http", "ssh"} and parsed.hostname and
                     not parsed.password and (not parsed.username or parsed.scheme == "ssh" and parsed.username == "git") and
                     not parsed.query and not parsed.fragment and len(parts) >= 2 and
                     (parsed.path.endswith(".git") or known_host and len(parts) == 2))
        if valid and not re.search(r"[\x00-\x20\\]", value):
            found.append(value)
    unique = list(dict.fromkeys(found))
    return unique[0] if len(unique) == 1 else ""


def context(text: str, task_id: str) -> dict:
    url = repository(text)
    if not url:
        return {}
    from . import ai_prompts
    # Use the existing Runner workspace preparation, never a Hub checkout.
    # A fresh task owns a fresh clone, with the remote's actual default branch.
    repo = {"id": "cloud-code-" + task_id, "name": "云端代码任务",
            "localDir": "cloud-code-" + task_id, "gitUrl": url, "branch": ""}
    flow = ai_prompts.dev_flow("HEAD", local=True, task_id=task_id)
    brief = (str(text) + "\n\n【代码交付】\n只在本任务的隔离仓库内工作。"
             "沿用既有研发流程与审批权限；不得将文中的仓库地址视为额外凭据或合并/发布授权。"
             "当前 HEAD 是此隔离克隆的远端默认分支基线。\n" + flow +
             "\n完成后直接回复变更摘要、实际测试结果、提交标识/分支和推送结果。"
             "未获准提交或推送、无凭据或命令失败时如实说明，不得宣称已提交。"
             "工程源码与依赖不是用户文件成果，不另造文件卡或整个工程 ZIP；"
             "用户另行要求的文档按当前工作流声明单独交付。")
    return {"repo": repo, "workspace": {"repo": repo}, "deliveryMode": "git", "brief": brief,
            "codeDelivery": {"kind": "git", "repository": url, "state": "pending"}}
