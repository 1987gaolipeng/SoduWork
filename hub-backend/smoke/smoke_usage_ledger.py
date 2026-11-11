"""Unified usage ledger contract; isolated in-memory smoke."""
import asyncio
import os
from datetime import datetime, timedelta, timezone

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from sqlalchemy import func, select

from app import automation_models as am, models
from app.db import Base, SessionLocal, engine
from app.services import usage_analytics, usage_ledger


CHECKS = 0


def ok(value, message):
    global CHECKS
    assert value, message
    CHECKS += 1


async def main():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    openai = usage_ledger.normalize_usage({
        "input_tokens": 100, "cached_input_tokens": 40, "output_tokens": 10})
    ok(openai["total_tokens"] == 110, "OpenAI cached input must not be double counted")
    ok(openai["cache_read_tokens"] == 40, "cache detail retained")
    anthropic = usage_ledger.normalize_usage({
        "input_tokens": 60, "cache_read_input_tokens": 40, "output_tokens": 10})
    ok(anthropic["total_tokens"] == 110, "Anthropic cache is separate input")
    ok(not anthropic["input_includes_cache"], "provider semantics retained")

    async with SessionLocal() as session:
        user = models.User(
            id="usage-user", username="usage-user", display_name="用量用户",
            org_id="usage-org")
        client = models.Client(
            id="usage-client", name="用量电脑", user_ref=user.id,
            auth_state="active")
        foreign_user = models.User(
            id="foreign-user", username="foreign-user", display_name="Foreign",
            org_id="foreign-org")
        foreign_client = models.Client(
            id="foreign-client", name="foreign-client", user_ref=foreign_user.id,
            auth_state="active")
        foreign_task = models.Task(
            id="foreign-task", owner_client_id=foreign_client.id, title="Private task",
            created_by=foreign_user.id, assignee_user_id=foreign_user.id)
        task = models.Task(
            id="usage-task", owner_client_id=client.id, title="商业化用量验证",
            created_by=user.id, assignee_user_id=user.id)
        execution = am.ExecutionSession(
            id="usage-session", task_id=task.id, ref="usage-ref",
            runner_id="runner-any", runner_client_id=client.id,
            engine="future-agent", model="future-model", state="done",
            metadata_={"usage": {
                "input": 120, "output": 30, "cacheRead": 50,
                "inputIncludesCache": True, "steps": 4,
            }})
        session.add_all([
            user, client, task, execution, foreign_user, foreign_client, foreign_task,
        ])
        await session.flush()
        await usage_ledger.from_execution(
            session, execution, task, owner_client=client, billing_user=user)
        await usage_ledger.from_execution(
            session, execution, task, owner_client=client, billing_user=user)
        chat_start = datetime.now(timezone.utc).replace(hour=23, minute=30, second=0, microsecond=0) - timedelta(days=2)
        chat_retry = chat_start + timedelta(hours=1, minutes=30)
        await usage_ledger.from_client(session, client, {
            "idempotencyKey": "chat-1", "sourceId": "chat-1",
            "conversationId": "chat-1", "agent": "pi",
            "sourceTitle": "  周报整理与今日同步  ",
            "model": "office-model", "occurredAt": chat_start.isoformat(),
            "usage": {"input": 80, "output": 20}})
        await usage_ledger.from_client(session, client, {
            "idempotencyKey": "chat-1", "sourceId": "chat-1",
            "conversationId": "chat-1", "agent": "pi", "sourceType": "task",
            "taskId": foreign_task.id,
            "model": "office-model", "occurredAt": chat_retry.isoformat(),
            "usage": {"input": 40, "output": 10}})
        beijing = timezone(timedelta(hours=8))
        today_report = datetime.now(beijing).astimezone(timezone.utc)
        yesterday_report = (today_report - timedelta(days=1))
        await usage_ledger.from_client(session, client, {
            "idempotencyKey": "cross-day", "sourceId": "cross-day",
            "conversationId": "cross-day", "agent": "pi",
            "model": "office-model", "occurredAt": yesterday_report.isoformat(),
            "usage": {"input": 1000, "output": 0}})
        await usage_ledger.from_client(session, client, {
            "idempotencyKey": "cross-day", "sourceId": "cross-day",
            "conversationId": "cross-day", "agent": "pi",
            "model": "office-model", "occurredAt": today_report.isoformat(),
            "usage": {"input": 1800, "output": 0}})
        await usage_ledger.from_client(session, client, {
            "idempotencyKey": "cross-day", "sourceId": "cross-day",
            "conversationId": "cross-day", "agent": "pi",
            "model": "office-model", "occurredAt": today_report.isoformat(),
            "usage": {"input": 1800, "output": 0}})
        await session.commit()

        count = (await session.execute(
            select(func.count(models.AIUsageEvent.id)))).scalar_one()
        ok(count == 3, "execution heartbeat and client retry are idempotent")
        chat = (await session.execute(select(models.AIUsageEvent).where(
            models.AIUsageEvent.conversation_id == "chat-1"))).scalar_one()
        ok(chat.total_tokens == 100, "stale cumulative retry cannot reduce counters")
        ok(chat.billing_user_id == user.id, "device identity owns chat usage")
        ok(chat.task_id == "", "device cannot link usage to another user's task")
        ok(chat.source_type == "chat", "invalid task attribution falls back to chat")
        ok(chat.source_title == "周报整理与今日同步", "conversation title stored trimmed")
        chat_time = chat.occurred_at if chat.occurred_at.tzinfo else chat.occurred_at.replace(tzinfo=timezone.utc)
        ok(chat_time == chat_start,
           "cumulative retry keeps the first usage timestamp")
        task_row = (await session.execute(select(models.AIUsageEvent).where(
            models.AIUsageEvent.task_id == task.id))).scalar_one()
        ok(task_row.agent_key == "future-agent", "new agent names need no schema change")
        ok(task_row.total_tokens == 150, "effective task tokens preserved")
        cross_day = (await session.execute(select(models.AIUsageEvent).where(
            models.AIUsageEvent.conversation_id == "cross-day"))).scalar_one()
        daily_rows = (await session.execute(select(models.AIUsageDaily).where(
            models.AIUsageDaily.usage_event_id == cross_day.id
        ).order_by(models.AIUsageDaily.day_key))).scalars().all()
        ok([int(item.total_tokens or 0) for item in daily_rows] == [1000, 800],
           "cross-day cumulative increment is assigned to the report day")
        report = await usage_analytics.overview(
            session, days=30, user_id=user.id)
        ok(report["summary"]["tokens"] == 2050, "personal total spans cumulative chat and tasks")
        ok(len(report["byAgent"]) == 2, "agent breakdown is dynamic")
        ok(report["quality"]["coveragePct"] == 100, "reported data quality visible")
        ok(report["recent"][0]["user"] == "用量用户", "user display name resolved")
        titles = {row["sourceId"]: row["title"] for row in report["recent"]}
        ok(titles.get("chat-1") == "周报整理与今日同步",
           "chat events show the reported conversation title")
        ok(all(t != "新建会话" for t in titles.values()),
           "legacy generic label never reappears")
        trend_total = sum(int(item["tokens"] or 0) for item in report["trend"])
        ok(trend_total == report["summary"]["tokens"],
           "daily trend reconciles to summary without moving cumulative rows")
    await engine.dispose()
    print("usage ledger smoke: %d assertions passed" % CHECKS)


if __name__ == "__main__":
    asyncio.run(main())
