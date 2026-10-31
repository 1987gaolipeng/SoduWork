"""Build governed SoduWork plugin packages from the employee-facing maker.

The maker emits the same immutable package consumed by the normal import path.
Preview and submission therefore cannot bypass parsing, quarantine, trust review or binding.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import zipfile

from . import (execution_capabilities, plugin_input_contracts,
               plugin_route_contracts, plugin_setup_contracts,
               plugin_signatures, plugin_ui_contracts, plugin_icons, plugin_window_contracts)
from . import plugin_platforms
from . import plugin_app_contracts
from .skill_frontmatter import quote_scalar

_KEY = re.compile(r"^[a-z][a-z0-9-]{1,62}$")
_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$")
_TEMPLATES = {"method", "connector", "workflow", "app"}


def _text(value, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _complete_text(value, limit: int, label: str) -> str:
    text = str(value or "").strip()
    if len(text) > limit:
        raise ValueError(f"{label}不能超过 {limit} 字符")
    return text


def _key(value: str) -> str:
    source = str(value or "").strip()
    key = re.sub(r"[^a-z0-9]+", "-", source.lower()).strip("-")[:63]
    digest = hashlib.sha256(source.encode("utf-8")).hexdigest()[:10]
    if any(ord(char) > 127 for char in source):
        key = ((key[:50].rstrip("-") + "-") if key else "company-") + digest
    if not key or not key[0].isalpha():
        key = "company-" + digest
    return key[:63].rstrip("-")


def _version(value) -> str:
    version = _text(value, 40) or "0.1.0"
    if not _VERSION.fullmatch(version):
        raise ValueError("插件版本必须是 SemVer，例如 0.1.0")
    return version


def _names(value) -> list[str]:
    raw = value if isinstance(value, list) else re.split(r"[,，\n]", str(value or ""))
    out = []
    for item in raw:
        name = _text(item, 80)
        if name and name not in out:
            out.append(name)
        if len(out) >= 30:
            break
    return out


def _criteria(value) -> list[str]:
    raw = value if isinstance(value, list) else re.split(r"[\n；;]", str(value or ""))
    out = []
    for item in raw:
        criterion = _text(item, 300)
        if criterion and criterion not in out:
            out.append(criterion)
        if len(out) >= 20:
            break
    return out

def _entrypoints(value, template: str) -> dict[str, bool]:
    defaults = {
        "conversation": template != "workflow",
        "task": True,
        "automation": template == "workflow",
    }
    if value is not None and not isinstance(value, dict):
        raise ValueError("插件使用入口必须是对象")
    raw = dict(value or {})
    out = {key: bool(raw.get(key, default)) for key, default in defaults.items()}
    if not any(out.values()):
        raise ValueError("插件至少要开放普通会话、任务执行或自动化中的一个入口")
    return out


def _node_capabilities(skills: list[str], mcp_servers: list[str], runtime: list[str]) -> dict:
    return {
        "skills": list(skills),
        "mcpServers": list(mcp_servers),
        "secrets": [],
        "runtime": list(runtime),
        "network": bool(mcp_servers),
    }


def _nodes(template: str, instructions: str, skills: list[str],
           mcp_servers: list[str], runtime: list[str]) -> list[dict]:
    capabilities = _node_capabilities(skills, mcp_servers, runtime)
    finish = (
        "全程自主判断，不在中途向用户提问。完成后交付可直接验收的最终成果，并说明"
        "做了什么、如何验证、仍需人处理什么。\n\n企业工作方法：\n" + instructions
    )
    work = {
        "key": "work", "type": "ai", "name": "AI 执行",
        "outputs": [{"key": "result", "kind": "evidence", "label": "交付成果",
                     "required": True}],
        "capabilities": capabilities,
        "config": {"prompt": finish, "timeoutSeconds": 3600}, "retry": {"maxAttempts": 2},
    }
    if template == "workflow":
        plan = {
            "key": "understand", "type": "ai", "name": "理解与规划",
            "outputs": [{"key": "plan", "kind": "evidence", "label": "执行计划",
                         "required": True}],
            "capabilities": capabilities,
            "config": {"prompt": (
                "理解任务目标、输入、限制与完成标准，形成可执行计划并直接继续，不向用户中途提问。"
                "计划要覆盖交付物、验证方式和风险。\n\n企业工作方法：\n" + instructions),
                "timeoutSeconds": 3600},
            "retry": {"maxAttempts": 2},
        }
        work["dependsOn"] = ["understand"]
        work["inputs"] = [{
            "key": "plan", "fromNode": "understand", "outputKey": "plan",
            "label": "执行计划", "required": True,
        }]
        nodes = [plan, work]
    else:
        nodes = [work]
    nodes.extend([
        {
            "key": "accept", "type": "human_review", "name": "人工验收",
            "dependsOn": ["work"],
            "inputs": [{
                "key": "result", "fromNode": "work", "outputKey": "result",
                "label": "待验收成果", "required": True,
            }],
            "config": {"action": "uat", "summary": "按任务完成标准验收本次交付"},
        },
        {
            "key": "complete", "type": "publish", "name": "办结沉淀",
            "dependsOn": ["accept"],
            "config": {"message": "成果已验收，任务完成并保留全过程证据"},
        },
    ])
    return nodes

_SECRET_FIELD = re.compile(r"password|passwd|token|secret|private.?key|api.?key", re.I)
_CONCRETE_ROUTE_FIELDS = {"runnerId", "hostId", "clientId", "machineId", "endpoint"}


def _has_content(value) -> bool:
    if isinstance(value, (list, tuple, set, dict)):
        return bool(value)
    return bool(str(value or "").strip())


def _has_secret_field(value) -> bool:
    if isinstance(value, dict):
        return any((_SECRET_FIELD.search(str(key)) and _has_content(child))
                   or _has_secret_field(child)
                   for key, child in value.items())
    if isinstance(value, list):
        return any(_has_secret_field(child) for child in value)
    return False


def _workflow_nodes(body: dict, template: str, instructions: str, own_skill: str,
                    skills: list[str],
                    mcp_servers: list[str], runtime: list[str]) -> list[dict]:
    raw_workflow = body.get("workflow")
    if template != "workflow" or not isinstance(raw_workflow, dict) \
            or not raw_workflow.get("nodes"):
        return _nodes(template, instructions, skills, mcp_servers, runtime)
    source = raw_workflow.get("nodes")
    if not isinstance(source, list) or not (1 <= len(source) <= 30):
        raise ValueError("个人插件工作流必须包含 1 到 30 个节点")
    if _has_secret_field(source):
        raise ValueError("插件工作流不能保存密码、密钥或令牌，请发布后绑定 Secret Reference")
    nodes = json.loads(json.dumps(source, ensure_ascii=False))
    default_capabilities = _node_capabilities(skills, mcp_servers, runtime)
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            raise ValueError(f"工作流第 {index + 1} 个节点必须是对象")
        node_type = _text(node.get("type"), 32).lower()
        if node_type not in {"ai", "ai_review"}:
            continue
        config = node.get("config")
        if not isinstance(config, dict):
            config = {}
            node["config"] = config
        concrete = sorted(_CONCRETE_ROUTE_FIELDS.intersection(config))
        if concrete:
            raise ValueError(
                f"节点 {_text(node.get('key'), 64) or index + 1} 不能绑定具体机器："
                + "、".join(concrete))
        nested = config.get("execution") if isinstance(config.get("execution"), dict) else {}
        kind = _text(nested.get("agentKind") or config.get("agentKind"), 40).lower()
        fallback = _text(
            nested.get("fallbackMode") or config.get("fallbackMode"), 20).lower()
        if not plugin_route_contracts.valid_agent_kind(kind):
            raise ValueError(
                f"节点 {_text(node.get('key'), 64) or index + 1} 选择了不支持的 Agent")
        if fallback and fallback not in {"strict", "best-effort"}:
            raise ValueError(
                f"节点 {_text(node.get('key'), 64) or index + 1} 的降级策略不合法")
        if node.get("capabilities") is None:
            node["capabilities"] = default_capabilities
        elif not isinstance(node.get("capabilities"), dict):
            raise ValueError(
                f"节点 {_text(node.get('key'), 64) or index + 1} 的能力声明必须是对象")
        else:
            selected = (_names(node["capabilities"].get("skills"))
                        if "skills" in node["capabilities"] else list(skills))
            unknown = [name for name in selected if name not in skills]
            if unknown:
                raise ValueError(
                    f"节点 {_text(node.get('key'), 64) or index + 1} 使用了插件未声明的 Skill："
                    + "、".join(unknown))
            node["capabilities"]["skills"] = [
                own_skill, *[name for name in selected if name != own_skill]]
    return nodes


def _expected_outputs(nodes: list[dict]) -> list[str]:
    all_outputs, required = [], []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        node_key = _text(node.get("key"), 64)
        for output in node.get("outputs") or []:
            if not isinstance(output, dict):
                continue
            output_key = _text(output.get("key"), 64)
            if not node_key or not output_key:
                continue
            output_id = f"{node_key}.{output_key}"
            all_outputs.append(output_id)
            if output.get("required", True):
                required.append(output_id)
    return required or all_outputs


def build(body: dict, signature: dict | None = None) -> bytes:
    """Return a standard zip package; callers still run normal parse/install."""
    from . import plugin_resources
    resources = plugin_resources.normalize(body.get('resources'))
    template = _text(body.get("template"), 20).lower()
    distribution = _text(body.get("distribution"), 24).lower()
    if distribution and distribution != "standalone":
        raise ValueError("plugin distribution must be standalone when provided")
    if template not in _TEMPLATES:
        raise ValueError("请选择工作方法、系统连接、自动化流程或应用模板")
    name = _text(body.get("name"), 120)
    description = _complete_text(body.get("description"), 600, "插件用途说明")
    instructions = _complete_text(body.get("instructions"), 8000, "插件工作方法")
    key = _key(body.get("key") or name)
    version = _version(body.get("version"))
    if not name or not description or not instructions:
        raise ValueError("插件名称、用途说明和工作方法都要写清楚")
    if not _KEY.fullmatch(key):
        raise ValueError("插件标识只允许小写字母、数字和短横线")
    mcp_servers = _names(body.get("mcpServers"))
    external_skills = [
        name for name in _names(body.get("skills")) if name != key]
    declared_skills = [key, *external_skills]
    runtime = execution_capabilities.normalize(
        _names(body.get("runtimeCapabilities") or body.get("runtime")))
    platforms = plugin_platforms.normalize(body.get("platforms"))
    if "feishu" in platforms and "feishu" not in mcp_servers:
        mcp_servers.append("feishu")
    if platforms:
        runtime = execution_capabilities.normalize([*runtime, "files", "terminal"])
    evaluation_instruction = _text(body.get("evaluationInstruction"), 2000)
    evaluation_criteria = _criteria(body.get("evaluationCriteria"))
    public_inputs = plugin_input_contracts.normalize(body.get("inputs"))
    install_setup = plugin_setup_contracts.normalize(body.get("setup"))
    plugin_ui = plugin_ui_contracts.normalize(body.get("ui"), install_setup)
    plugin_app_contracts.validate(template, plugin_ui)
    if template == "connector" and not plugin_platforms.connector_ready(
            mcp_servers, runtime, resources, platforms):
        raise ValueError("系统连接插件需要声明 MCP、平台账号连接，或终端能力与随包 CLI 脚本")
    if bool(evaluation_instruction) != bool(evaluation_criteria):
        raise ValueError("发布评测试题和验收标准需要一起填写")
    capabilities = _node_capabilities(declared_skills, mcp_servers, runtime)
    if platforms:
        capabilities["platforms"] = platforms
    capabilities["network"] = bool(mcp_servers or platforms or template in {"connector", "app"})
    has_workflow = template == "workflow"
    workflow_nodes = _workflow_nodes(
        body, template, instructions, key, declared_skills, mcp_servers, runtime)
    if platforms or template in {"connector", "app"}:
        for node in workflow_nodes:
            if node.get("type") in {"ai", "ai_review"}:
                node.setdefault("capabilities", {})["network"] = True

    manifest = {
        "schemaVersion": 1, "key": key, "name": name, "version": version,
        "description": description,
        "author": _text(body.get("author"), 120) or "SoduWork 员工",
        "inputs": public_inputs,
        "setup": install_setup,
        "ui": plugin_ui,
        "outputs": [{"key": "result", "label": "交付成果", "accept": []}],
        "instructions": instructions,
        "entrypoints": _entrypoints(body.get("entrypoints"), template),
        "capabilities": capabilities,
        "evaluations": ([{
            "key": "representative-case", "name": "代表性任务",
            "instruction": evaluation_instruction, "inputs": {},
            "criteria": evaluation_criteria,
            "expectedOutputs": _expected_outputs(workflow_nodes) if has_workflow else ["execute.result"],
        }] if evaluation_instruction else []),
    }
    if body.get('appCategory') is not None:
        manifest['appCategory'] = plugin_app_contracts.category(body['appCategory'])
    if body.get('extensions') is not None:
        from . import plugin_extensions
        manifest['extensions'] = plugin_extensions.normalize(body['extensions'])
    if distribution:
        manifest['distribution'] = distribution
    from . import plugin_locales
    locales = plugin_locales.normalize(body.get('locales'))
    if locales is not None:
        manifest['locales'] = locales
    if template == 'app':
        manifest['template'] = 'app'
    from . import plugin_covers
    cover = plugin_covers.normalize(body.get('coverUrl'))
    if cover:
        manifest['coverUrl'] = cover
    icon = plugin_icons.normalize(body.get('icon'))
    app_window = plugin_window_contracts.normalize(body.get('appWindow'))
    if app_window is not None:
        manifest['appWindow'] = app_window
    if body.get('jiyong') is not None:
        from . import jiyong_contract
        manifest['jiyong'] = jiyong_contract.normalize(body['jiyong'])
        if manifest['jiyong'].get('initialization'):
            from . import jiyong_initialization
            jiyong_initialization.parse(manifest['jiyong'],resources)
    if icon:
        manifest['icon'] = icon
    if resources:
        manifest['resources'] = plugin_resources.summary(resources)
    skill = (
        "---\nname: %s\ndescription: %s\n---\n\n# %s\n\n%s\n\n"
        "## 交付要求\n\n- 直接完成任务，不在中途向用户提问。\n"
        "- 交付前验证成果完整性并保留证据。\n"
        "- 明确列出假设、风险与仍需人处理的事项。\n"
    ) % (quote_scalar(key), quote_scalar(description), name, instructions)
    if resources:
        skill += '\n## 随包资源\n\n相对本 Skill 目录读取；复制模板后编辑，不改原文件。脚本只在用户任务授权范围内按需执行。\n' + '\n'.join('- ' + item['path'] for item in resources) + '\n'
    files = {
        "plugin.json": json.dumps(manifest, ensure_ascii=False, indent=2),
        "skills/%s/SKILL.md" % key: skill,
    }
    if has_workflow:
        files["workflow.json"] = json.dumps(
            {"nodes": workflow_nodes}, ensure_ascii=False, indent=2)
    if signature:
        files[plugin_signatures.SIGNATURE_PATH] = json.dumps(
            signature, ensure_ascii=False, indent=2)
    for resource in resources:
        files['skills/' + key + '/' + resource['path']] = base64.b64decode(resource['content'])
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for filename in sorted(files):
            info = zipfile.ZipInfo(filename, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            value = files[filename]
            archive.writestr(info, value if isinstance(value, bytes) else value.encode("utf-8"))
    return out.getvalue()
