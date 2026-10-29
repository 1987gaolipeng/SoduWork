"""Trust and organization scope for plugin version bindings."""
from sqlalchemy import select
from app import automation_models as am
from app import models
from app.services import plugin_runtime
from app.services import plugin_service
from app.services import workflow_engine
from .support import BASE, FLOW, package
from .fixtures import repository_fixture, ambiguous_repository_fixture


async def bindings(chk, actor):
    'Organization boundaries, trust gates and immutable version bindings.'
    session, creator, box, task = actor.session, actor.creator, actor.box, actor.task
    creator_id, creator_name, box_id = creator.id, creator.display_name, box.id
    single_project, single_repo, single_task = await repository_fixture(session, box)
    ambiguous_task = await ambiguous_repository_fixture(session, box)
    chk("任务时间线事件类型容得下发布审批命名空间",
        models.TaskEvent.__table__.c.kind.type.length >= len("release.approval_requested"),
        models.TaskEvent.__table__.c.kind.type.length)
    await session.commit()
    inherited = await workflow_engine._bind_single_project_repo(session, single_task)
    chk("单仓库项目的任务会自动固化默认仓库",
        inherited is not None and single_task.repo_id == single_repo.id, single_task.repo_id)
    ambiguous = await workflow_engine._bind_single_project_repo(session, ambiguous_task)
    chk("多仓库项目不会靠名称猜任务仓库",
        ambiguous is None and not ambiguous_task.repo_id, ambiguous_task.repo_id)
    installed = await plugin_service.install(
        session, package(BASE, FLOW), creator, None,
        source_channel="client-package", source_name="../prototype-kit.zip")
    plugin = await session.get(am.Plugin, installed["plugin"]["id"])
    version = (await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.plugin_id == plugin.id))).scalar_one()
    chk("新版本进入隔离区且默认停用",
        installed["created"] and not plugin.enabled
        and version.trust_state == "quarantined" and not version.enabled)
    proof = plugin_service.provenance_api(version.provenance, version.checksum)
    chk("不可变版本固化发布者、渠道、摘要且不会保留上传路径",
        proof["publisherId"] == creator_id
        and proof["publisherName"] == creator_name
        and proof["channel"] == "client-package"
        and proof["sourceName"] == "prototype-kit.zip"
        and proof["checksum"] == version.checksum
        and proof["signatureState"] == "unsigned", proof)
    duplicate = await plugin_service.install(
        session, package(BASE, FLOW, stamp=(2024, 1, 2, 3, 4, 6)), creator, None)
    chk("相同内容即使打包时间不同也保持幂等", not duplicate["created"])

    blocked = False
    try:
        await plugin_service.save_binding(session, plugin, {"versionId": version.id})
    except ValueError:
        blocked = True
    chk("隔离版本不能绑定到任务", blocked)

    await plugin_service.approve_version(session, version, True, creator_name)
    leaked = False
    try:
        await plugin_service.save_binding(session, plugin, {
            "versionId": version.id, "config": {"apiToken": "plaintext"}})
    except ValueError:
        leaked = True
    chk("绑定配置拒绝疑似凭据明文", leaked)
    foreign_org = models.OrgUnit(id="org-plugin-foreign", name="别家公司")
    foreign_secret = am.SecretReference(
        id="secret-plugin-foreign", org_id=foreign_org.id, name="别家公司密钥",
        provider="runner-env", locator="FOREIGN_TOKEN")
    foreign_project = models.Project(
        id="project-plugin-foreign", name="别家公司项目", org_id=foreign_org.id)
    session.add_all([foreign_org, foreign_secret, foreign_project])
    await session.commit()
    cross_secret = cross_project = False
    try:
        await plugin_service.save_binding(session, plugin, {
            "versionId": version.id, "secretRefs": {"TOKEN": foreign_secret.id}})
    except ValueError:
        cross_secret = True
    try:
        await plugin_service.save_binding(session, plugin, {
            "versionId": version.id, "projectId": foreign_project.id})
    except ValueError:
        cross_project = True
    chk("插件绑定不能借用别的组织的密钥引用", cross_secret)
    chk("插件绑定不能冒用别的组织的项目", cross_project)
    legacy_binding = am.PluginBinding(
        id="binding-plugin-legacy-org", plugin_id=plugin.id, version_id=version.id,
        org_id=None, project_id=foreign_project.id, enabled=True)
    session.add(legacy_binding)
    await session.commit()
    legacy_binding = await plugin_service.save_binding(
        session, plugin, {"versionId": version.id}, legacy_binding)
    chk("旧项目绑定首次升级时从真实项目补齐组织归属",
        legacy_binding.org_id == foreign_org.id, legacy_binding.org_id)
    enterprise_binding = await plugin_service.save_binding(session, plugin, {
        "versionId": version.id, "projectId": foreign_project.id,
        "orgId": foreign_org.id, "config": {"agentKind": "local:pi"}})
    chk("全局内置插件可显式落成企业自己的项目绑定",
        enterprise_binding.org_id == foreign_org.id
        and enterprise_binding.project_id == foreign_project.id)
    binding = await plugin_service.save_binding(session, plugin, {
        "versionId": version.id, "config": {"agentKind": "local:pi"}})
    runtime_secret = am.SecretReference(
        id="secret-plugin-runtime", org_id=None, name="插件运行密钥",
        provider="runner-env", locator="SMOKE_PLUGIN_SECRET_SOURCE")
    session.add(runtime_secret)
    await session.flush()
    binding.secret_refs = {"JIRA_TOKEN": runtime_secret.id}
    secret_sources = await plugin_runtime.resolve_secret_sources(
        session, binding, ["JIRA_TOKEN"])
    chk("Hub 解析插件密钥时只返回 Runner 环境变量名而不读取明文",
        secret_sources == {"JIRA_TOKEN": "SMOKE_PLUGIN_SECRET_SOURCE"},
        secret_sources)
    old_report = dict(version.capability_report or {})
    version.capability_report = {**old_report, "secrets": ["JIRA_TOKEN"]}
    ready_with_secret = await plugin_service.binding_readiness(
        session, version, None, None, secret_refs=binding.secret_refs)
    missing_secret = await plugin_service.binding_readiness(
        session, version, None, None, secret_refs={})
    chk("绑定预检在启动前指出缺失密钥并认可有效映射",
        ready_with_secret["ok"] and not missing_secret["ok"]
        and any("JIRA_TOKEN" in x for x in missing_secret["blockers"]),
        (ready_with_secret, missing_secret))
    version.capability_report = old_report
    binding.secret_refs = {}
    project_binding = await plugin_service.save_binding(session, plugin, {
        "versionId": version.id, "projectId": single_project.id})
    wrong_project_binding = False
    try:
        await plugin_service.resolve_binding(
            session, ambiguous_task, binding_id=project_binding.id)
    except ValueError:
        wrong_project_binding = True
    chk("客户端即使拿到绑定 ID 也不能跨项目启动插件", wrong_project_binding)
    resolved = await plugin_service.resolve_binding(
        session, task, plugin_id=plugin.id, org_ids=None)
    chk("审批后的插件可建立并解析绑定", resolved.id == binding.id)
    breaking_version = am.PluginVersion(
        id="version-plugin-breaking", plugin_id=plugin.id, version="2.0.0",
        checksum="breaking-upgrade", manifest=dict(version.manifest or {}),
        workflow={"nodes": []}, capability_report=dict(version.capability_report or {}),
        trust_state="approved", enabled=True)
    session.add(breaking_version)
    await session.commit()
    breaking_blocked = False
    try:
        await plugin_service.save_binding(
            session, plugin, {"versionId": breaking_version.id}, binding)
    except ValueError:
        breaking_blocked = True
    chk("项目绑定升级到破坏性插件版本前必须明确确认", breaking_blocked)
    upgraded = await plugin_service.save_binding(
        session, plugin, {"versionId": breaking_version.id,
                          "confirmBreaking": True}, binding)
    chk("管理员确认后才能固定到破坏性新版本",
        upgraded.version_id == breaking_version.id)
    binding = await plugin_service.save_binding(
        session, plugin, {"versionId": version.id,
                          "confirmBreaking": True}, binding)
