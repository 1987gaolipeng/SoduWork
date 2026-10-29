"""Manifest contracts and package import safety."""
import base64
import hashlib
import inspect
import io
import json
import os
import zipfile
from datetime import datetime
from datetime import timedelta
from datetime import timezone
from types import SimpleNamespace
from app import automation_models as am
from app.services import agent_route_selection
from app.services import ai_exec
from app.services import immutable_cache
from app.services import local_base
from app.services import plugin_evaluations
from app.services import plugin_packages
from app.services import plugin_route_readiness
from app.services import plugin_service
from app.services import plugin_starter
from app.services import runner_skills
from app.services import workflow_context
from app.services import workflow_contracts
from app.services import workflow_engine
from app.services import workflow_runs
from .support import BASE, FLOW, package, external_package


async def catalog(chk):
    'Public authoring, routing and typed manifest contracts.'
    chk("工作流自动降级覆盖平台登记的全部本地执行底座",
        set(ai_exec.LOCAL_AGENT_KINDS) == {
            "local:" + key for key in local_base._PROFILES}
        and "ai_exec.LOCAL_AGENT_KINDS" in inspect.getsource(
            agent_route_selection.resolve_sync)
        and "_PROFILES" in inspect.getsource(ai_exec._declared_local_agent_kinds),
        ai_exec.LOCAL_AGENT_KINDS)
    chk("模拟、发布评测与真实执行共用同一个 Agent/模型路由器",
        all("agent_route_selection.resolve_sync" in inspect.getsource(fn) for fn in (
            plugin_route_readiness.check, plugin_evaluations.start,
            workflow_engine._execute_ai)), "路由规则不能在插件子系统中复制")
    route_node = {
        "key": "review", "type": "ai_review", "name": "AI 审查",
        "config": {"agentKind": "local:qwen", "model": "review-v1",
                   "fallbackMode": "best-effort", "runnerTags": ["gpu"]},
    }
    public_route = plugin_service.public_workflow_node(
        route_node, capability_report={"runtime": ["browser"]})
    overridden_route = plugin_service.public_workflow_node(route_node, {
        "nodeOverrides": {
            "review": {"execution": {"agentKind": "local:codex"}}
        }
    })
    chk("任务插件目录公开逐节点 Agent 和模型但不泄露具体执行机",
        public_route["route"]["agentKind"] == "local:qwen"
        and public_route["route"]["model"] == "review-v1"
        and public_route["route"]["agentSource"] == "plugin"
        and public_route["route"]["runtime"] == ["browser"]
        and public_route["route"]["runnerTags"] == ["gpu"]
        and "runnerId" not in json.dumps(public_route), public_route)
    chk("项目节点覆盖与插件模型分别保留清晰来源",
        overridden_route["route"]["agentKind"] == "local:codex"
        and overridden_route["route"]["model"] == "review-v1"
        and overridden_route["route"]["agentSource"] == "project"
        and overridden_route["route"]["modelSource"] == "plugin", overridden_route)
    chk("非 AI 节点不虚构执行路由",
        "route" not in plugin_service.public_workflow_node(
            {"key": "accept", "type": "human_review", "name": "人工验收"}))
    starter_blob = plugin_starter.build()
    starter = plugin_packages.parse(starter_blob)
    starter_nodes = starter["workflow"]["nodes"]
    chk("作者起步包可被真实解析器直接预检且构建结果稳定",
        plugin_starter.build() == starter_blob
        and starter["manifest"]["key"] == "enterprise-workflow-starter"
        and len(starter_nodes) == 5, starter)
    implement = next(x for x in starter_nodes if x["key"] == "implement")
    chk("作者起步包演示类型化跨 Agent 交接和逐节点显式最小权限",
        implement["inputs"][0]["fromNode"] == "understand"
        and implement["inputs"][0]["outputKey"] == "plan"
        and implement["capabilities"]["explicit"]
        and not implement["capabilities"]["skills"], implement)
    rich_inputs = plugin_packages.parse(package({
        **BASE, "key": "rich-input-contract", "inputs": [
            {"key": "goal", "type": "string", "multiline": True,
             "label": "目标", "description": "说明完整交付目标", "required": True},
            {"key": "level", "type": "select", "label": "级别",
             "options": ["团队", {"value": "company", "label": "公司"}],
             "default": "company"},
            {"key": "threshold", "type": "number", "default": 80},
        ],
    }, FLOW))
    rich_fields = plugin_service.public_inputs(rich_inputs["manifest"])
    chk("插件公开参数在导入边界规范化并保留说明、选项和默认值",
        rich_fields[0]["type"] == "textarea"
        and rich_fields[0]["description"] == "说明完整交付目标"
        and rich_fields[1]["options"][1]["value"] == "company"
        and rich_fields[1]["default"] == "company"
        and rich_fields[2]["default"] == 80, rich_fields)
    secret_input_rejected = False
    try:
        plugin_packages.parse(package({
            **BASE, "key": "secret-form-input",
            "inputs": [{"key": "apiToken", "type": "text"}],
        }, FLOW))
    except ValueError as exc:
        secret_input_rejected = "SecretReference" in str(exc)
    chk("插件公开表单不能绕过密钥引用收集凭据", secret_input_rejected)
    normalized_run_inputs = workflow_runs._validate_workflow_inputs(
        rich_inputs["manifest"], {"goal": "完成交付", "level": "company"})
    chk("运行前按不可变清单补默认值并规范化参数类型",
        normalized_run_inputs == {
            "goal": "完成交付", "level": "company", "threshold": 80.0},
        normalized_run_inputs)
    undeclared_input_rejected = False
    try:
        workflow_runs._validate_workflow_inputs(
            rich_inputs["manifest"], {"goal": "完成交付", "debugToken": "leak"})
    except ValueError as exc:
        undeclared_input_rejected = "未声明" in str(exc)
    chk("运行时拒绝清单外参数进入工作流上下文", undeclared_input_rejected)
    now = datetime.now(timezone.utc)
    health = plugin_service._plugin_health_summary([
        SimpleNamespace(state="succeeded", plugin_version_id="v2",
                        created_at=now, started_at=now - timedelta(minutes=8),
                        finished_at=now),
        SimpleNamespace(state="succeeded", plugin_version_id="v2",
                        created_at=now, started_at=now - timedelta(minutes=12),
                        finished_at=now),
        SimpleNamespace(state="failed", plugin_version_id="v1",
                        created_at=now, started_at=now - timedelta(minutes=3),
                        finished_at=now),
    ], [
        SimpleNamespace(run_id="r3", node_key="quality", error="质量命令失败",
                        created_at=now, finished_at=now),
    ], {"v1": "1.0.0", "v2": "2.0.0"})
    chk("插件健康度来自真实运行并给出成功率、耗时与失败热点",
        health["runs"] == 3 and health["successRate"] == 66.7
        and health["medianDurationMs"] == 8 * 60 * 1000
        and health["failureHotspots"][0]["nodeKey"] == "quality", health)
    chk("少量或低成功率运行不会被包装成健康",
        health["state"] == "critical", health)
    chk("running nodes emit dispatched events",
        workflow_engine._node_event_kind("running") == "node.dispatched")
    chk("terminal nodes emit succeeded events",
        workflow_engine._node_event_kind("succeeded") == "node.succeeded")
    failed_api = workflow_engine.node_api(am.NodeRun(
        node_key="deploy", node_type="deploy", state="failed",
        error="发布目标尚未配置", output={"failureKind": "configuration"}),
        {"name": "发布到验证环境"}, can_retry=True)
    chk("失败节点返回可操作诊断而不是只有错误字符串",
        failed_api["diagnosis"]["kind"] == "configuration"
        and failed_api["diagnosis"]["retryable"]
        and failed_api["diagnosis"]["requiresFix"], failed_api["diagnosis"])
    historical_api = workflow_engine.node_api(am.NodeRun(
        node_key="deploy", node_type="deploy", state="failed", error="旧失败"),
        can_retry=False)
    chk("历史失败尝试不会出现误导性的重复执行按钮",
        not historical_api["diagnosis"]["retryable"], historical_api["diagnosis"])


async def packages(chk):
    'Package safety, external adapters and immutable Skill caches.'
    traversal_rejected = False
    try:
        plugin_packages.parse(package(BASE, FLOW, {"../escape.txt": "no"}))
    except ValueError:
        traversal_rejected = True
    chk("压缩包越界路径在入库前被拒绝", traversal_rejected)
    portable_collision_rejected = False
    try:
        plugin_packages.parse(package(
            BASE, FLOW, {"Readme.md": "one", "README.md": "two"}))
    except ValueError:
        portable_collision_rejected = True
    chk("跨平台会落到同一文件的插件路径在入库前被拒绝",
        portable_collision_rejected)

    cyclic = {"nodes": [
        {"key": "a", "type": "validate", "dependsOn": ["b"]},
        {"key": "b", "type": "validate", "dependsOn": ["a"]},
    ]}
    cycle_rejected = False
    try:
        plugin_packages.parse(package({**BASE, "key": "cyclic"}, cyclic))
    except ValueError:
        cycle_rejected = True
    chk("循环 DAG 在导入时被拒绝", cycle_rejected)

    scoped_manifest = {**BASE, "key": "scoped-capabilities", "capabilities": {
        "skills": ["requirements"], "mcpServers": ["jira"],
        "secrets": ["JIRA_TOKEN"], "network": True}}
    scoped_flow = {"nodes": [{
        "key": "analyze", "type": "ai", "config": {"prompt": "analyze"},
        "capabilities": {"skills": ["requirements"], "secrets": ["JIRA_TOKEN"]},
    }]}
    scoped = plugin_packages.parse(package(scoped_manifest, scoped_flow))
    scoped_node = scoped["workflow"]["nodes"][0]["capabilities"]
    chk("AI 节点只获得自己声明的插件能力",
        scoped_node["skills"] == ["requirements"]
        and scoped_node["mcpServers"] == []
        and scoped_node["secrets"] == ["JIRA_TOKEN"]
        and not scoped_node["network"], scoped_node)
    undeclared_capability = False
    scoped_flow["nodes"][0]["capabilities"]["mcpServers"] = ["not-declared"]
    try:
        plugin_packages.parse(package(
            {**scoped_manifest, "key": "scoped-capabilities-bad"}, scoped_flow))
    except ValueError:
        undeclared_capability = True
    chk("节点不能越过插件能力边界申请未声明的 MCP", undeclared_capability)

    os.environ["SMOKE_PLUGIN_SECRET_SOURCE"] = "never-persist-this-value"
    try:
        child_env = local_base._env_for(
            {"needs_llm": False},
            {"runtimeSecrets": {"JIRA_TOKEN": "SMOKE_PLUGIN_SECRET_SOURCE"}})
        chk("插件密钥值只在执行机注入当前子进程",
            child_env.get("JIRA_TOKEN") == "never-persist-this-value")
    finally:
        os.environ.pop("SMOKE_PLUGIN_SECRET_SOURCE", None)

    quality_flow = {"nodes": [{
        "key": "quality", "type": "quality", "config": {"commands": [{
            "name": "backend", "workingDir": "backend",
            "argv": ["python", "-m", "pytest", "tests", "-q"],
        }]},
    }]}
    quality_package = plugin_packages.parse(package(
        {**BASE, "key": "quality-working-dir"}, quality_flow))
    quality_command = quality_package["workflow"]["nodes"][0]["config"]["commands"][0]
    chk("质量插件可以给每条结构化命令声明工程内工作目录",
        quality_command.get("workingDir") == "backend", quality_command)
    quality_escape = False
    quality_flow["nodes"][0]["config"]["commands"][0]["workingDir"] = "../outside"
    try:
        plugin_packages.parse(package(
            {**BASE, "key": "quality-working-dir-bad"}, quality_flow))
    except ValueError:
        quality_escape = True
    chk("插件导入阶段拒绝越过工程根的质量命令目录", quality_escape)

    contract_flow = {"nodes": [
        {"key": "analyze", "type": "ai", "config": {"prompt": "write spec"},
         "outputs": [{"key": "requirements", "kind": "file",
                       "label": "需求基线", "path": "requirements.md"}]},
        {"key": "implement", "type": "ai", "dependsOn": ["analyze"],
         "config": {"prompt": "implement"},
         "outputs": [{"key": "code", "kind": "git", "label": "代码提交"}]},
    ]}
    contract_package = plugin_packages.parse(package(
        {**BASE, "key": "node-output-contract"}, contract_flow))
    contract_nodes = contract_package["workflow"]["nodes"]
    chk("研发任务按节点声明交付方式而不是整条任务一刀切",
        workflow_contracts.delivery_mode(contract_nodes[0], True) == "files"
        and workflow_contracts.delivery_mode(contract_nodes[1], True) == "git",
        contract_nodes)
    missing_receipt = workflow_contracts.evaluate(contract_nodes[0], {}, {})
    good_receipt = workflow_contracts.evaluate(
        contract_nodes[0], {}, {"received": ["requirements.md"]})
    text_is_not_file = workflow_contracts.evaluate(
        contract_nodes[0], {"finalText": "a narrative result"}, {})
    evidence_receipt = workflow_contracts.evaluate(
        {"outputs": [{"key": "result", "kind": "evidence", "required": True}]},
        {"finalText": "a narrative result"}, {})
    chk("text satisfies generic evidence but never an explicit file contract",
        bool(text_is_not_file.get("missing")) and not evidence_receipt.get("missing")
        and evidence_receipt.get("text") == "a narrative result",
        (text_is_not_file, evidence_receipt))
    chk("节点契约能指出缺失的必交文件并认可真实回执",
        missing_receipt["missing"] == ["需求基线"] and not good_receipt["missing"],
        (missing_receipt, good_receipt))
    bad_output_path = False
    contract_flow["nodes"][0]["outputs"][0]["path"] = "../requirements.md"
    try:
        plugin_packages.parse(package(
            {**BASE, "key": "node-output-path-bad"}, contract_flow))
    except ValueError:
        bad_output_path = True
    chk("插件导入阶段拒绝越过工程根的节点文件产出", bad_output_path)
    typed_flow = {"nodes": [
        {"key": "analyze", "type": "ai", "config": {"prompt": "analyze"},
         "outputs": [
             {"key": "requirements", "kind": "file", "path": "requirements.md"},
             {"key": "notes", "kind": "file", "path": "private-notes.md"}]},
        {"key": "implement", "type": "ai", "dependsOn": ["analyze"],
         "inputs": [{"key": "approvedSpec", "fromNode": "analyze",
                     "outputKey": "requirements", "label": "已批准需求"}],
         "config": {"prompt": "implement"},
         "outputs": [{"key": "code", "kind": "git"}]},
    ]}
    typed_package = plugin_packages.parse(package(
        {**BASE, "key": "typed-node-inputs"}, typed_flow))
    typed_node = typed_package["workflow"]["nodes"][1]
    chk("节点可以声明只接收某个直接上游的指定产出",
        typed_node["inputs"] == [{
            "key": "approvedSpec", "fromNode": "analyze",
            "outputKey": "requirements", "label": "已批准需求", "required": True}],
        typed_node["inputs"])
    typed_handoff = workflow_context.dependency_handoff({"dependencies": {
        "analyze": {
            "outputReceipt": {"declared": [
                {"key": "requirements", "kind": "file", "label": "需求",
                 "ok": True, "value": "requirements.md"},
                {"key": "notes", "kind": "file", "label": "私密笔记",
                 "ok": True, "value": "private-notes.md"}]},
            "attachments": [{"id": "requirements.md", "filename": "requirements.md"}],
            "internalNotes": "must-not-leak",
        }}}, typed_node["inputs"])
    chk("跨 Agent 交接只包含声明的产出而不泄漏上游完整上下文",
        typed_handoff["snapshot"]["mode"] == "declared"
        and typed_handoff["resolvedInputs"]["approvedSpec"]["value"]
        == "requirements.md"
        and "must-not-leak" not in typed_handoff["prompt"],
        typed_handoff)
    public_handoff = workflow_context.public_handoff({
        "dependencies": {"analyze": {"internalNotes": "must-not-leak"}},
        "resolvedInputs": typed_handoff["resolvedInputs"],
        "contextSnapshot": typed_handoff["snapshot"],
    })
    chk("客户端只拿到交接来源和类型，不拿上游正文、路径或完整依赖",
        public_handoff["resolvedInputs"]["approvedSpec"]["kind"] == "file"
        and "value" not in public_handoff["resolvedInputs"]["approvedSpec"]
        and "dependencies" not in public_handoff
        and "must-not-leak" not in json.dumps(public_handoff),
        public_handoff)
    crowded_handoff = workflow_context.dependency_handoff({"dependencies": {
        "node-" + str(index): {"summary": "长内容" * 900, "result": index}
        for index in range(40)
    }}, max_chars=1000)
    crowded_payload = json.loads(crowded_handoff["prompt"].split("\n", 2)[2])
    chk("超长跨 Agent 上下文会压缩为合法 JSON 而不是从中间截断",
        crowded_handoff["snapshot"]["truncated"]
        and crowded_payload["_soduwork"]["truncated"] is True
        and crowded_handoff["snapshot"]["chars"] <= 1000,
        crowded_handoff["snapshot"])
    bad_typed_output = json.loads(json.dumps(typed_flow))
    bad_typed_output["nodes"][1]["inputs"][0]["outputKey"] = "missing"
    rejected_bad_input = False
    try:
        plugin_packages.parse(package(
            {**BASE, "key": "typed-node-input-missing"}, bad_typed_output))
    except ValueError:
        rejected_bad_input = True
    chk("插件导入阶段拒绝引用上游未声明的产出", rejected_bad_input)
    missing_required = False
    try:
        workflow_context.dependency_handoff(
            {"dependencies": {"analyze": {}}}, typed_node["inputs"])
    except workflow_contracts.WorkflowContractError:
        missing_required = True
    chk("运行时缺少必需交接产出时阻断下游 Agent", missing_required)

    decision_flow = {"nodes": [{
        "key": "preflight", "type": "ai", "config": {"prompt": "preflight"},
        "outputs": [{"key": "gate", "kind": "decision", "label": "执行前置结论",
                     "path": "workflow-decision.json"}],
    }]}
    decision_package = plugin_packages.parse(package(
        {**BASE, "key": "node-decision-contract"}, decision_flow))
    decision_node = decision_package["workflow"]["nodes"][0]
    decision_receipt = workflow_contracts.evaluate(
        decision_node, {}, {"received": ["workflow-decision.json"]})
    chk("结构化节点决策按文件回流并进入强制产出契约",
        workflow_contracts.delivery_mode(decision_node, True) == "files"
        and not decision_receipt["missing"], decision_receipt)
    tagged_flow = {"nodes": [{
        "key": "build", "type": "ai",
        "config": {"prompt": "build", "runnerTags": ["Docker", "linux", "docker"]},
    }]}
    tagged_package = plugin_packages.parse(package(
        {**BASE, "key": "tagged-runner-node"}, tagged_flow))
    chk("AI 节点的执行机标签在导入时规范化、去重并保持机器无关",
        tagged_package["workflow"]["nodes"][0]["config"]["runnerTags"]
        == ["docker", "linux"], tagged_package["workflow"])
    tagged_flow["nodes"][0]["config"]["runnerTags"] = ["trial 专用"]
    bad_runner_tag = False
    try:
        plugin_packages.parse(package(
            {**BASE, "key": "bad-runner-tag"}, tagged_flow))
    except ValueError:
        bad_runner_tag = True
    chk("插件导入拒绝不稳定或不可移植的执行机标签", bad_runner_tag)
    timeout_flow = {"nodes": [{
        "key": "bounded", "type": "ai",
        "config": {"prompt": "完成工作", "timeoutSeconds": 900},
    }]}
    timeout_package = plugin_packages.parse(package(
        {**BASE, "key": "bounded-ai-node"}, timeout_flow))
    timeout_flow["nodes"][0]["config"]["timeoutSeconds"] = 59
    bad_timeout = False
    try:
        plugin_packages.parse(package(
            {**BASE, "key": "bad-ai-timeout"}, timeout_flow))
    except ValueError:
        bad_timeout = True
    chk("AI 节点运行上限在导入时规范化并拒绝不安全范围",
        timeout_package["workflow"]["nodes"][0]["config"]["timeoutSeconds"] == 900
        and bad_timeout, timeout_package["workflow"])
    duplicate_decision = False
    decision_flow["nodes"][0]["outputs"].append(
        {"key": "gate2", "kind": "decision", "path": "decision-2.json"})
    try:
        plugin_packages.parse(package(
            {**BASE, "key": "duplicate-node-decision"}, decision_flow))
    except ValueError:
        duplicate_decision = True
    chk("一个节点不能交付相互矛盾的两份继续/阻断结论", duplicate_decision)

    codex_raw = external_package("codex", {
        "name": "team-requirement", "version": "2.3.0",
        "description": "把团队需求整理成可执行方案",
        "interface": {"displayName": "团队需求整理"},
    }, {"skills/requirement/SKILL.md": (
        "---\nname: requirement-workshop\n"
        "description: 梳理需求并输出验收标准\n---\n# 方法\n逐条澄清目标。\n"),
        "skills/requirement/references/template.md": "# 验收标准\n",
        ".mcp.json": json.dumps({"mcp_servers": {"docs": {
            "command": "must-not-run", "env": {"TOKEN": "must-not-import"}}}}),
        ".app.json": "{}", "monitors/monitors.json": "{}", "bin/setup.js": ""})
    codex = plugin_packages.parse(codex_raw)
    chk("Codex 插件无需桥接清单即可转换为 SoduWork 工作流",
        codex["sourceKind"] == "codex"
        and codex["manifest"]["version"] == "2.3.0"
        and codex["workflow"]["nodes"][0]["type"] == "ai",
        codex)
    chk("Codex 包内 Agent Skill 被识别为版本锁定能力",
        codex["capabilities"]["bundledSkills"][0]["name"] == "requirement-workshop"
        and codex["capabilities"]["externalSkills"] == [], codex["capabilities"])
    codex_personal = plugin_packages.personal_draft(codex)
    chk("Codex 包预检可生成不执行第三方代码的本机个人试用快照",
        codex_personal["sourceKind"] == "codex"
        and codex_personal["importChecksum"] == codex["checksum"]
        and "SKILL.md" in codex_personal["instructions"]
        and any("逐条澄清目标" in base64.b64decode(row["content"]).decode("utf-8")
                for row in codex_personal["resources"] if row["path"].endswith("SKILL.md"))
        and codex_personal["mcpServers"] == ["docs"]
        and "可执行文件" in codex_personal["unsupportedComponents"],
        codex_personal)
    codex_summary = plugin_packages.public_summary(codex)
    chk("公开预检同时返回可安装个人快照但不返回原包字节",
        codex_summary["personalDraft"]["name"] == "团队需求整理"
        and "bytes" not in codex_summary
        and len(codex_summary["personalDraft"]["instructions"]) <= 8000,
        codex_summary)
    chk("Codex 注册应用、监控与可执行文件在预检中披露且绝不自动执行",
        {"已注册 MCP 应用", "后台监控", "可执行文件"}.issubset(
            set(codex["capabilities"]["unsupportedComponents"])),
        codex["capabilities"]["unsupportedComponents"])
    chk("第三方 MCP 只导入逻辑名并要求企业重新配置连接",
        codex["capabilities"]["mcpServers"] == ["docs"]
        and "MCP 配置" not in codex["capabilities"]["unsupportedComponents"]
        and "must-not-run" not in json.dumps(codex["manifest"], ensure_ascii=False)
        and any("逻辑连接名" in item for item in
                codex["capabilities"]["adapterWarnings"]), codex["capabilities"])
    codex_path = plugin_packages.store(codex)
    # Simulate a transient first rename failure caused by Windows file locking.
    # Verify bounded retry rather than exposing intermittent access-denied errors to users.
    real_rename = immutable_cache.os.rename
    rename_attempts = 0

    def flaky_rename(source, target):
        nonlocal rename_attempts
        rename_attempts += 1
        if rename_attempts == 1:
            raise PermissionError(5, "simulated file scanner lock", source, target)
        return real_rename(source, target)

    immutable_cache.os.rename = flaky_rename
    try:
        materialized = plugin_packages.materialize_skills(
            codex_path, codex["checksum"], codex["capabilities"])
    finally:
        immutable_cache.os.rename = real_rename
    chk("包内技能只解到不可变缓存且保留参考资料",
        len(materialized) == 1
        and os.path.isfile(os.path.join(materialized[0]["path"], "SKILL.md"))
        and os.path.isfile(os.path.join(
            materialized[0]["path"], "references", "template.md")), materialized)
    changed_package_rejected = False
    try:
        plugin_packages.materialize_skills(
            codex_path, "0" * 64, codex["capabilities"])
    except ValueError:
        changed_package_rejected = True
    chk("技能缓存复核包内容，磁盘包被替换后不能冒充已审核版本",
        changed_package_rejected)
    invalid_checksum_rejected = False
    try:
        plugin_packages.materialize_skills(
            codex_path, "../outside-cache", codex["capabilities"])
    except ValueError:
        invalid_checksum_rejected = True
    chk("技能缓存只接受完整十六进制摘要，不能借摘要越出缓存根目录",
        invalid_checksum_rejected)
    from app.services import plugin_package_resources
    conversation_skill = plugin_package_resources.index(codex["resourceBundle"])
    skill_bodies = "\n".join(base64.b64decode(row["content"]).decode("utf-8")
                             for row in codex["resourceBundle"]["resources"]
                             if row["path"].endswith("SKILL.md"))
    chk("对话插件资源保留已审批 Skill 正文，索引指向完整技能文件",
        "requirement-workshop" in conversation_skill
        and "逐条澄清目标" in skill_bodies
        and "SKILL.md" in conversation_skill,
        conversation_skill)
    chk("Windows 短暂占用技能目录时会自动重试", rename_attempts == 2, rename_attempts)
    skill_bundle = runner_skills.build(materialized)
    runner_rename_attempts = 0

    def flaky_runner_rename(source, target):
        nonlocal runner_rename_attempts
        runner_rename_attempts += 1
        if runner_rename_attempts == 1:
            raise PermissionError(5, "simulated runner scanner lock", source, target)
        return real_rename(source, target)

    immutable_cache.os.rename = flaky_runner_rename
    try:
        runner_copy = runner_skills.install(
            skill_bundle, hashlib.sha256(skill_bundle).hexdigest())
    finally:
        immutable_cache.os.rename = real_rename
    chk("包内技能能经完整性校验送到远程 Runner",
        len(runner_copy) == 1 and runner_copy[0]["name"] == "requirement-workshop"
        and os.path.isfile(os.path.join(runner_copy[0]["path"], "SKILL.md")), runner_copy)
    chk("Runner 技能缓存同样耐受 Windows 短暂占用",
        runner_rename_attempts == 2, runner_rename_attempts)

    claude = plugin_packages.parse(external_package("claude", {
        "name": "prototype-kit", "description": "输出 HTML 产品原型",
        "hooks": {"PostToolUse": []},
    }, {"skills/prototype/SKILL.md": (
        "---\nname: prototype\ndescription: 生成自包含、可交互的 HTML 产品原型\n---\n# 原型\n"),
        "hooks/hooks.json": "{}"}, root="catalog/prototype-kit"))
    chk("嵌套目录里的 Claude 插件可直导且缺失版本按内容固化",
        claude["sourceKind"] == "claude"
        and claude["manifest"]["version"].startswith("0.0.0+")
        and claude["capabilities"]["bundledSkills"][0]["name"] == "prototype",
        claude)
    manifestless = io.BytesIO()
    with zipfile.ZipFile(manifestless, "w") as archive:
        archive.writestr("team-skills/skills/brief/SKILL.md",
                         "---\nname: team-brief\ndescription: 形成团队工作简报\n---\n# 简报\n")
        archive.writestr("team-skills/skills/brief/references/template.md", "# 模板\n")
    manifestless_claude = plugin_packages.parse(manifestless.getvalue())
    chk("无 plugin.json 的合法 Claude Skill 插件按默认目录安全导入",
        manifestless_claude["sourceKind"] == "claude"
        and manifestless_claude["manifest"]["name"] == "team-skills"
        and manifestless_claude["capabilities"]["bundledSkills"][0]["name"] == "team-brief"
        and manifestless_claude["capabilities"]["hasScript"] is False,
        manifestless_claude)
    chk("不支持的第三方 hooks 会在预检中明确披露而不执行",
        "hooks" in claude["capabilities"]["unsupportedComponents"]
        and claude["capabilities"]["adapterWarnings"], claude["capabilities"])
