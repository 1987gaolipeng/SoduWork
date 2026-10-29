"""Unified discovery catalog for Agent Skills and MCP connections.

The catalog is intentionally descriptive: trusted built-ins and official MCP
templates appear automatically, while installation, authorization and runtime
binding remain explicit separate steps.  A catalog entry must never silently
grant filesystem, network or command execution access.
"""
from __future__ import annotations

import os
import asyncio

from . import skills
from . import connector_catalog


MCP_TEMPLATES: tuple[dict, ...] = (
    {
        "key": "mcp-filesystem", "kind": "mcp", "name": "文件与目录",
        "description": "在明确授权的目录内读取、搜索和整理文件。",
        "source": "MCP 官方参考实现", "trust": "official", "risk": "write",
        "permissions": ["读取授权目录", "修改授权目录内文件"],
        "requires": ["Node.js", "本机 Runner 在线", "确认授权目录"],
        "template": {"name": "文件与目录", "type": "stdio", "command": "npx",
                     "args": ["-y", "@modelcontextprotocol/server-filesystem",
                              "${SODUWORK_WORK_ROOT}"],
                     "description": "只访问本次授权的 SoduWork 工作根目录", "enabled": False},
    },
    {
        "key": "mcp-git", "kind": "mcp", "name": "Git 仓库",
        "description": "读取仓库历史、差异与状态，并在授权时执行仓库操作。",
        "source": "MCP 官方参考实现", "trust": "official", "risk": "write",
        "permissions": ["读取 Git 仓库", "可能修改仓库状态"],
        "requires": ["uvx", "Git", "本机 Runner 在线"],
        "template": {"name": "Git 仓库", "type": "stdio", "command": "uvx",
                     "args": ["mcp-server-git", "--repository", "${SODUWORK_WORK_DIR}"],
                     "description": "操作当前任务的 Git 工作目录", "enabled": False},
    },
    {
        "key": "mcp-fetch", "kind": "mcp", "name": "网页内容读取",
        "description": "获取公开网页并转换为适合 AI 阅读的内容。",
        "source": "MCP 官方参考实现", "trust": "official", "risk": "network",
        "permissions": ["访问外部网络", "读取网页内容"],
        "requires": ["uvx", "本机 Runner 在线", "网络策略允许"],
        "template": {"name": "网页内容读取", "type": "stdio", "command": "uvx",
                     "args": ["mcp-server-fetch"],
                     "description": "读取公开网页内容", "enabled": False},
    },
    {
        "key": "mcp-time", "kind": "mcp", "name": "时间与时区",
        "description": "查询当前时间并做可靠的时区换算。",
        "source": "MCP 官方参考实现", "trust": "official", "risk": "read",
        "permissions": ["读取时间与时区"],
        "requires": ["uvx", "本机 Runner 在线"],
        "template": {"name": "时间与时区", "type": "stdio", "command": "uvx",
                     "args": ["mcp-server-time"],
                     "description": "时间查询与时区换算", "enabled": False},
    },
    {
        "key": "mcp-memory", "kind": "mcp", "name": "结构化记忆",
        "description": "把可复用事实沉淀为结构化知识，并在后续任务中检索。",
        "source": "MCP 官方参考实现", "trust": "official", "risk": "write",
        "permissions": ["保存结构化知识", "读取历史知识"],
        "requires": ["Node.js", "本机 Runner 在线", "确认数据保留策略"],
        "template": {"name": "结构化记忆", "type": "stdio", "command": "npx",
                     "args": ["-y", "@modelcontextprotocol/server-memory"],
                     "description": "保存可复用的结构化工作记忆", "enabled": False},
    },
    {
        "key": "mcp-sequential-thinking", "kind": "mcp", "name": "结构化推理",
        "description": "把复杂问题拆成可修正、可回溯的思考步骤，适合研究、规划和故障分析。",
        "source": "MCP 官方参考实现", "trust": "official", "risk": "read",
        "permissions": ["在本次会话内保存推理步骤"],
        "requires": ["Node.js", "本机 Runner 在线"],
        "template": {"name": "结构化推理", "type": "stdio", "command": "npx",
                     "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"],
                     "description": "为复杂工作提供可回溯的分步思考", "enabled": False},
    },
)


MCP_TEMPLATES = (*MCP_TEMPLATES, *connector_catalog.templates())


def mcp_template(key: str) -> dict | None:
    return next((dict(item) for item in MCP_TEMPLATES if item["key"] == str(key or "")), None)


def _source(item: dict) -> tuple[str, str]:
    return skills.source_info(item)


def skill_entry(item: dict, allowed: set[str], selected: set[str]) -> dict:
    source, source_key = _source(item)
    trust = (source_key if source_key in ("personal", "company", "builtin")
             else "local")
    personal = item.get("scope") == "personal"
    local = item.get("scope") == "local"
    available = (personal or local or item.get("name") in allowed or
                 item.get("name") in skills.BASELINE_SKILLS)
    portable = bool(item.get("bundled")) or os.path.normcase(str(item.get("root") or "")) == \
        os.path.normcase(skills.bundled_root())
    return {
        "key": "skill:" + str(item.get("name") or ""), "kind": "skill",
        "name": item.get("name", ""), "description": item.get("description", ""),
        "compatibility": item.get("compatibility", ""), "source": source,
        "sourceKey": source_key,
        "builtIn": source_key == "builtin",
        "canDelete": personal and bool(item.get("packageChecksum")),
        "trust": trust, "scope": item.get("scope") or "company",
        "ownerClientId": item.get("ownerClientId") or "",
        "version": str(item.get("packageChecksum") or item.get("version") or "")[:12],
        "available": available, "enabled": available and item.get("name") in selected,
        "status": ("enabled" if available and item.get("name") in selected else
                   "available" if available else "blocked"),
        "permissions": ["按 SKILL.md 中声明的方法工作"],
        "hasScripts": bool(item.get("hasScripts")),
        "portable": portable,
        "localOnly": local,
        "runtimeAvailable": bool(item.get("runtimeAvailable") or local),
        "runtimeSources": list(item.get("runtimeSources") or [])[:8],
    }


async def client_catalog(session, client) -> dict:
    cfg, rows = await skills.catalog_with_policy(session, client)
    allowed = set(cfg.get("allowed") or [])
    from . import skill_preferences
    selected = skill_preferences.selected_names(client, rows)
    entries = [skill_entry(item, allowed, selected) for item in rows]
    personal_mcp = list(getattr(client, "mcp_servers", None) or [])
    selected_mcp = list(getattr(client, "mcp_enabled", None) or [])
    return {
        "skills": entries,
        "mcpTemplates": [dict(item) for item in MCP_TEMPLATES],
        "summary": {
            "skills": len(entries),
            "enabledSkills": sum(1 for item in entries if item["enabled"]),
            "personalSkills": sum(1 for item in entries if item["scope"] == "personal"),
            "localSkills": sum(1 for item in entries if item["scope"] == "local"),
            "personalMcp": len(personal_mcp),
            "companyMcpEnabled": len(selected_mcp),
            "mcpReady": "mcp-tools" in allowed,
        },
    }


async def admin_catalog(session) -> dict:
    from . import skill_packages
    from ..models import Client
    from sqlalchemy import select

    cfg, rows = await skills.catalog_with_policy(session)
    allowed = set(cfg.get("allowed") or [])
    company = [skill_entry(item, allowed, set()) for item in rows]
    usage: dict[str, int] = {}
    for client in (await session.execute(select(Client))).scalars().all():
        for name in (client.skills or []):
            usage[str(name)] = usage.get(str(name), 0) + 1
    for item in company:
        item["allowed"] = item["name"] in allowed
        item["inUse"] = usage.get(item["name"], 0)
    personal = []
    for item in await asyncio.to_thread(skill_packages.active, include_all_personal=True, include_company=False):
        personal.append(skill_entry(item, allowed, set()))
    return {
        "skills": company, "personalSubmissions": personal,
        "mcpTemplates": [{**item, "builtIn": True, "canDelete": False} for item in MCP_TEMPLATES],
        "cfg": cfg, "homeRoot": skills.home_root(),
        "roots": skills.default_roots() + list(cfg.get("roots") or []),
        "summary": {"skills": len(company), "allowed": len(allowed),
                    "personalSubmissions": len(personal),
                    "mcpTemplates": len(MCP_TEMPLATES)},
    }
