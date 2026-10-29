"""Small actor, repository and approved-plugin fixtures for isolated cases."""
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import automation_models as am, models
from app.services import plugin_service
from .support import BASE, FLOW, package


@dataclass
class ActorFixture:
    session: AsyncSession
    creator: models.User
    box: models.Client
    task: models.Task


@dataclass
class ApprovedPluginFixture:
    plugin: am.Plugin
    version: am.PluginVersion
    binding: am.PluginBinding


async def actor_fixture(session: AsyncSession) -> ActorFixture:
    creator = models.User(id="u-plugin-smoke", username="plugin-smoke",
                          display_name="插件验收人", is_super=True, is_active=True)
    creator._perms = {"plugin.manage", "plugin.run", "release.approve"}
    box = models.Client(id="c-plugin-smoke", user_ref=creator.id, name="插件 SoduWork")
    task = models.Task(id="t-plugin-smoke", owner_client_id=box.id,
                       title="输出产品原型", created_by=creator.id,
                       created_by_name=creator.display_name)
    session.add_all([creator, box, task])
    await session.flush()
    session.add(models.Attachment(
        id="att-plugin-smoke", task_id=task.id, filename="prototype.html",
        content_type="text/html", size=1200, storage_key="smoke/prototype.html",
        backend="local", uploaded_by="agent:runner", role="output",
        evidence_meta={"category": "primary", "verification": {"state": "passed"}}))
    await session.commit()
    return ActorFixture(session, creator, box, task)


async def repository_fixture(session, box):
    project = models.Project(id="project-plugin-smoke", name="单仓库项目")
    repo = models.Repo(id="repo-plugin-smoke", project_id=project.id,
                       name="唯一仓库", git_url="https://example.invalid/repo.git")
    task = models.Task(id="t-plugin-single", owner_client_id=box.id,
                       title="自动继承唯一仓库", project_id=project.id)
    session.add_all([project, repo, task])
    await session.commit()
    return project, repo, task


async def ambiguous_repository_fixture(session, box):
    project = models.Project(id="project-plugin-multi", name="多仓库项目")
    task = models.Task(id="t-plugin-multi", owner_client_id=box.id,
                       title="需要明确选择仓库", project_id=project.id)
    session.add_all([
        project, task,
        models.Repo(id="repo-plugin-front", project_id=project.id, name="前端"),
        models.Repo(id="repo-plugin-back", project_id=project.id, name="后端"),
    ])
    await session.commit()
    return task


async def approved_plugin_fixture(actor: ActorFixture) -> ApprovedPluginFixture:
    session, creator = actor.session, actor.creator
    installed = await plugin_service.install(
        session, package(BASE, FLOW), creator, None,
        source_channel="client-package", source_name="../prototype-kit.zip")
    plugin = await session.get(am.Plugin, installed["plugin"]["id"])
    version = (await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.plugin_id == plugin.id))).scalar_one()
    await plugin_service.approve_version(session, version, True, creator.display_name)
    binding = await plugin_service.save_binding(
        session, plugin, {"versionId": version.id, "config": {"agentKind": "local:pi"}})
    return ApprovedPluginFixture(plugin, version, binding)


async def receipt_task_fixture(session, box):
    task = models.Task(id="t-plugin-receipt", owner_client_id=box.id, title="验证产出回流版本")
    session.add(task)
    await session.commit()
    return task
