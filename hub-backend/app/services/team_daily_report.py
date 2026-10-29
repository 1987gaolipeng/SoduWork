"""Hierarchical team periodic reports built from immutable source snapshots.

Direct member reports are aggregated at their organisation node.  Parent nodes then consume the
already-summarised reports of their direct children, so a leader reads a team pulse rather than a
long concatenation of individual diaries.  Every report carries source fingerprints; changed
facts invalidate a previous confirmation on the next generation.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from . import daily_report, llm, rbac


_RISK_WORDS = ("风险", "阻塞", "卡住", "失败", "异常", "退回", "没通过", "问题")
_COORD_WORDS = ("等待", "协同", "协调", "依赖", "配合", "确认", "支持")
_DAILY_SYSTEM = (
    "你是企业团队负责人助理。请依据输入事实撰写一份给上级阅读的团队日报，不能逐人罗列，"
    "要归纳团队整体成果、推进状态、风险协同和下一步关注。所有结论只能来自输入，禁止编造。"
    "正文不超过500字，纯文本，不用Markdown；没有事实的段落省略。第一段直接说今天团队完成了什么，"
    "随后按【关键成果】【推进与关注】【风险与协同】【覆盖情况】组织。覆盖不完整必须如实说明。"
)
_WEEKLY_SYSTEM = (
    "你是企业团队负责人助理。请依据输入事实撰写一份给上级阅读的团队周报，不能逐人或逐日罗列，"
    "要归纳团队本周整体成果、持续推进、风险协同和下周关注。所有结论只能来自输入，禁止编造。"
    "正文不超过800字，纯文本，不用Markdown；没有事实的段落省略。覆盖不完整必须如实说明。"
)


async def _generation_lock(session: AsyncSession, day: str, period_type: str) -> None:
    """Serialize overlapping team-report generation inside one PostgreSQL transaction."""
    bind = session.get_bind()
    if bind.dialect.name != "postgresql":
        return
    lock_key = f"soduwork:team-report:{period_type}:{day}"
    await session.execute(
        text(
            "SELECT pg_advisory_xact_lock("
            "hashtextextended(CAST(:lock_key AS text), 0))"
        ),
        {"lock_key": lock_key},
    )


def _digest(value) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _ms(value) -> int | None:
    return int(value.timestamp() * 1000) if value else None


def _clip(value, limit: int = 220) -> str:
    return " ".join(str(value or "").split())[:limit]


def _entry(text: str, source_id: str, *, owner: str = "", team: str = "") -> dict:
    item = {"text": _clip(text), "sourceIds": [str(source_id)]}
    if owner:
        item["owners"] = [owner]
    if team:
        item["teams"] = [team]
    return item


def _merge_entries(rows: list[dict], limit: int = 10) -> list[dict]:
    merged: dict[str, dict] = {}
    for row in rows:
        text = _clip(row.get("text"))
        if not text:
            continue
        key = text.casefold()
        target = merged.setdefault(key, {"text": text, "sourceIds": [], "owners": [], "teams": []})
        for field in ("sourceIds", "owners", "teams"):
            for value in row.get(field) or []:
                if value and value not in target[field]:
                    target[field].append(value)
    out = []
    for row in merged.values():
        out.append({key: value for key, value in row.items() if value})
        if len(out) >= limit:
            break
    return out


def _latest_personal(rows: list[models.DailyReport]) -> list[models.DailyReport]:
    """Use one source snapshot per person even if a pre-constraint database contains duplicates."""
    latest: dict[tuple[str, str], models.DailyReport] = {}
    for report in rows:
        key = (str(report.org_id or ""), str(report.user_id or ""))
        version = (_ms(report.created_at) or 0, str(report.id or ""))
        previous = latest.get(key)
        previous_version = ((_ms(previous.created_at) or 0, str(previous.id or ""))
                            if previous is not None else (-1, ""))
        if version >= previous_version:
            latest[key] = report
    return sorted(latest.values(), key=lambda row: (str(row.org_id or ""), row.user_id, row.id))


def _active_items(report: models.DailyReport) -> int:
    items = [item for item in list(report.items or []) if isinstance(item, dict)]
    if items:
        return sum(not bool(item.get("closedInPeriod", item.get("closedToday"))) for item in items)
    # Legacy rows without item snapshots counted all touched tasks in active_count, including done.
    return max(0, int(report.active_count or 0) - int(report.done_count or 0))


def _member_facts(reports: list[models.DailyReport]) -> dict[str, list[dict]]:
    facts = {"outcomes": [], "inProgress": [], "risks": [], "coordination": [],
             "nextFocus": []}
    for report in reports:
        owner = report.user_name or report.user_id
        for item in list(report.items or []):
            title = _clip(item.get("title") or "未命名事项", 100)
            progress = [_clip(value, 140) for value in (item.get("progress") or []) if _clip(value)]
            detail = "；".join(progress[:2])
            text = title + (("：" + detail) if detail else "")
            if item.get("closedInPeriod", item.get("closedToday")):
                facts["outcomes"].append(_entry(text, report.id, owner=owner))
            else:
                facts["inProgress"].append(_entry(text, report.id, owner=owner))
                facts["nextFocus"].append(_entry(title, report.id, owner=owner))
            for note in progress:
                if any(word in note for word in _RISK_WORDS):
                    facts["risks"].append(_entry(f"{title}：{note}", report.id, owner=owner))
                if any(word in note for word in _COORD_WORDS):
                    facts["coordination"].append(
                        _entry(f"{title}：{note}", report.id, owner=owner))
        # Old reports may not have structured items; retain explicit risk sentences as evidence.
        if not report.items:
            for line in str(report.content or "").splitlines():
                clean = _clip(line)
                if clean and any(word in clean for word in _RISK_WORDS):
                    facts["risks"].append(_entry(clean, report.id, owner=owner))
    return facts


def _child_facts(reports: list[models.TeamDailyReport]) -> dict[str, list[dict]]:
    facts = {"outcomes": [], "inProgress": [], "risks": [], "coordination": [],
             "nextFocus": []}
    for report in reports:
        for key in facts:
            for item in list((report.summary or {}).get(key) or []):
                facts[key].append({
                    "text": item.get("text") or "",
                    "sourceIds": list(dict.fromkeys([
                        report.id, *(item.get("sourceIds") or []),
                    ])),
                    "owners": list(item.get("owners") or []),
                    "teams": list(dict.fromkeys([
                        report.org_name, *(item.get("teams") or []),
                    ])),
                })
    return facts


def _report_ref(report: models.DailyReport) -> dict:
    fingerprint = _digest({
        "id": report.id, "period": report.period_type, "content": report.content, "items": report.items,
        "done": report.done_count, "active": report.active_count,
        "progress": report.progress_count,
    })
    return {"kind": "member", "id": report.id, "name": report.user_name,
            "digest": fingerprint}


def _team_ref(org: models.OrgUnit, report: models.TeamDailyReport | None) -> dict:
    return {"kind": "team", "orgId": org.id, "name": org.name,
            "id": report.id if report else "", "digest": report.source_digest if report else "",
            "status": report.status if report else "missing"}


def _compose(org: models.OrgUnit, direct_reports: list[models.DailyReport],
             child_orgs: list[models.OrgUnit], child_reports: list[models.TeamDailyReport],
             direct_member_total: int) -> tuple[dict, dict, list[dict], str]:
    member, child = _member_facts(direct_reports), _child_facts(child_reports)
    summary = {key: _merge_entries(member[key] + child[key]) for key in member}
    child_by_org = {report.org_id: report for report in child_reports}
    metrics = {
        "directMemberTotal": direct_member_total,
        "directReportedMembers": len({row.user_id for row in direct_reports}),
        "memberTotal": direct_member_total + sum(
            int((row.metrics or {}).get("memberTotal") or 0) for row in child_reports),
        "reportedMembers": len({row.user_id for row in direct_reports}) + sum(
            int((row.metrics or {}).get("reportedMembers") or 0) for row in child_reports),
        "childTeamsTotal": len(child_orgs),
        "childTeamsReady": len(child_reports),
        "childTeamsConfirmed": sum(row.status == "confirmed" for row in child_reports),
        "doneCount": sum(int(row.done_count or 0) for row in direct_reports) + sum(
            int((row.metrics or {}).get("doneCount") or 0) for row in child_reports),
        "activeCount": sum(_active_items(row) for row in direct_reports) + sum(
            int((row.metrics or {}).get("activeCount") or 0) for row in child_reports),
        "progressCount": sum(int(row.progress_count or 0) for row in direct_reports) + sum(
            int((row.metrics or {}).get("progressCount") or 0) for row in child_reports),
        "riskCount": len(summary["risks"]),
        "coordinationCount": len(summary["coordination"]),
    }
    total = int(metrics["memberTotal"] or 0)
    metrics["coverage"] = round(metrics["reportedMembers"] / total, 4) if total else 0
    refs = [_report_ref(row) for row in sorted(direct_reports, key=lambda x: x.id)]
    refs += [_team_ref(child_org, child_by_org.get(child_org.id))
             for child_org in sorted(child_orgs, key=lambda x: (x.sort, x.name, x.id))]
    digest = _digest({"orgId": org.id, "refs": refs, "metrics": metrics})
    return summary, metrics, refs, digest


def render_template(org_name: str, day: str, summary: dict, metrics: dict,
                    period_type: str = "daily") -> str:
    info = daily_report.period_info(period_type, day)
    weekly = info["type"] == "weekly"
    lines = [f"{info['label']} · {org_name}团队{'周报' if weekly else '概况'}", ""]
    total, reported = metrics.get("memberTotal", 0), metrics.get("reportedMembers", 0)
    lines.append(
        f"{'本周' if weekly else '今日'} {reported}/{total} 人形成有效{'周报' if weekly else '日报'}，"
        f"完成 {metrics.get('doneCount', 0)} 项，{metrics.get('activeCount', 0)} 项工作有推进。")
    sections = [
        ("关键成果", "outcomes"), ("推进与关注", "inProgress"),
        ("风险与协同", "risks"), ("需要协同", "coordination"),
    ]
    for title, key in sections:
        rows = list(summary.get(key) or [])
        if not rows:
            continue
        lines += ["", f"【{title}】"]
        lines += [f"  · {row['text']}" for row in rows[:8]]
    if reported < total:
        lines += ["", "【覆盖情况】",
                  f"  · 仍有 {total - reported} 人没有形成本{'周' if weekly else '日'}有效简报。"]
    return "\n".join(lines).strip()


async def _upsert(session: AsyncSession, org: models.OrgUnit, day: str,
                  direct_reports: list[models.DailyReport], child_orgs: list[models.OrgUnit],
                  child_reports: list[models.TeamDailyReport], direct_member_total: int,
                  existing: models.TeamDailyReport | None, force: bool,
                  period_type: str = "daily") -> models.TeamDailyReport:
    summary, metrics, refs, digest = _compose(
        org, direct_reports, child_orgs, child_reports, direct_member_total)
    if existing is not None and existing.source_digest == digest and not force:
        return existing
    info = daily_report.period_info(period_type, day)
    content, source = render_template(org.name, day, summary, metrics, info["type"]), "template"
    material = json.dumps({"团队": org.name, "周期": info["label"], "统计": metrics,
                           "事实": summary}, ensure_ascii=False, indent=1)
    system = _WEEKLY_SYSTEM if info["type"] == "weekly" else _DAILY_SYSTEM
    generated = await llm.chat(session, system, material, temperature=0.2)
    if generated:
        content, source = generated, "llm"
    report = existing or models.TeamDailyReport(
        org_id=org.id, period_type=info["type"], date=info["start"])
    # Confirmation applies to the report's actual conclusion as well as its source facts.
    # A regenerated body must not inherit confirmation solely because source_digest is unchanged.
    changed = bool(existing is not None and (
        existing.source_digest != digest
        or existing.content != content
        or dict(existing.summary or {}) != summary
        or dict(existing.metrics or {}) != metrics
    ))
    report.org_name, report.content, report.source = org.name, content, source
    report.period_type, report.date = info['type'], info['start']
    report.summary, report.metrics = summary, metrics
    report.source_refs, report.source_digest = refs, digest
    report.updated_at = datetime.now(timezone.utc)
    if existing is None:
        session.add(report)
    if changed:
        report.status = "generated"
        report.confirmed_by = report.confirmed_by_name = ""
        report.confirmed_at = None
        report.leader_note = ""
    return report


def _depth(org_id: str, parent: dict[str, str | None]) -> int:
    seen, depth, current = set(), 0, org_id
    while parent.get(current) and current not in seen:
        seen.add(current)
        current = str(parent[current])
        depth += 1
    return depth


async def generate_scope(session: AsyncSession, day: str, scope: set[str] | None,
                         *, force: bool = False,
                         period_type: str = "daily") -> list[models.TeamDailyReport]:
    info = daily_report.period_info(period_type, day)
    day, period_type = info["start"], info["type"]
    # A double click, retry or a second Hub instance may generate the same organisation rows.
    # Lock before reading existing rows so the waiter observes the committed winner.
    await _generation_lock(session, day, period_type)
    org_query = select(models.OrgUnit)
    if scope is not None:
        org_query = org_query.where(models.OrgUnit.id.in_(scope or {"__none__"}))
    orgs = list((await session.execute(org_query)).scalars().all())
    if not orgs:
        return []
    org_ids = {org.id for org in orgs}
    users = list((await session.execute(select(models.User).where(
        models.User.is_active.is_(True), models.User.org_id.in_(org_ids)
    ))).scalars().all())
    personal = _latest_personal(list((await session.execute(select(models.DailyReport).where(
        models.DailyReport.date == day, models.DailyReport.period_type == period_type,
        models.DailyReport.org_id.in_(org_ids)
    ))).scalars().all()))
    existing_rows = list((await session.execute(select(models.TeamDailyReport).where(
        models.TeamDailyReport.date == day, models.TeamDailyReport.period_type == period_type,
        models.TeamDailyReport.org_id.in_(org_ids)
    ))).scalars().all())
    existing = {row.org_id: row for row in existing_rows}
    parent = {org.id: org.parent_id for org in orgs}
    children: dict[str, list[models.OrgUnit]] = {}
    for org in orgs:
        if org.parent_id in org_ids:
            children.setdefault(str(org.parent_id), []).append(org)
    users_by_org: dict[str, int] = {}
    for user in users:
        users_by_org[str(user.org_id)] = users_by_org.get(str(user.org_id), 0) + 1
    reports_by_org: dict[str, list[models.DailyReport]] = {}
    for report in personal:
        reports_by_org.setdefault(str(report.org_id), []).append(report)

    generated: dict[str, models.TeamDailyReport] = {}
    for org in sorted(orgs, key=lambda row: _depth(row.id, parent), reverse=True):
        child_orgs = children.get(org.id, [])
        child_reports = [generated[row.id] for row in child_orgs if row.id in generated]
        generated[org.id] = await _upsert(
            session, org, day, reports_by_org.get(org.id, []), child_orgs, child_reports,
            users_by_org.get(org.id, 0), existing.get(org.id), force, period_type)
        await session.flush()
    await session.commit()
    for report in generated.values():
        await session.refresh(report)
    return sorted(generated.values(), key=lambda row: (_depth(row.org_id, parent), row.org_name))


def to_api(report: models.TeamDailyReport | None, *, stale: bool = False) -> dict | None:
    if report is None:
        return None
    info = daily_report.period_info(report.period_type, report.date)
    return {
        "id": report.id, "orgId": report.org_id, "orgName": report.org_name,
        "date": report.date, "periodType": info["type"], "periodStart": info["start"],
        "periodEnd": info["end"], "periodLabel": info["label"],
        "content": report.content, "source": report.source,
        "status": report.status, "summary": dict(report.summary or {}),
        "metrics": dict(report.metrics or {}), "sourceRefs": list(report.source_refs or []),
        "sourceDigest": report.source_digest, "needsRefresh": bool(stale),
        "confirmedBy": report.confirmed_by, "confirmedByName": report.confirmed_by_name,
        "confirmedAt": _ms(report.confirmed_at), "leaderNote": report.leader_note,
        "createdAt": _ms(report.created_at), "updatedAt": _ms(report.updated_at),
    }


async def overview(session: AsyncSession, actor: models.User, day: str,
                   org_id: str = "", period_type: str = "daily") -> dict:
    info = daily_report.period_info(period_type, day)
    day, period_type = info["start"], info["type"]
    scope = await rbac.scope_org_ids(session, actor)
    org_query = select(models.OrgUnit).order_by(models.OrgUnit.sort, models.OrgUnit.name)
    if scope is not None:
        org_query = org_query.where(models.OrgUnit.id.in_(scope or {"__none__"}))
    orgs = list((await session.execute(org_query)).scalars().all())
    org_by_id = {row.id: row for row in orgs}
    focus_id = str(org_id or actor.org_id or "")
    if focus_id and focus_id not in org_by_id:
        raise PermissionError("该团队不在你的管理范围内")
    if not focus_id and orgs:
        roots = [row for row in orgs if row.parent_id not in org_by_id]
        focus_id = (roots or orgs)[0].id
    if not focus_id:
        return {"date": day, "period": info, "teamReport": None, "orgs": [], "childTeams": [],
                "members": [], "reports": [], "breadcrumbs": []}

    report_rows = list((await session.execute(select(models.TeamDailyReport).where(
        models.TeamDailyReport.date == day,
        models.TeamDailyReport.period_type == period_type,
        models.TeamDailyReport.org_id.in_(set(org_by_id) or {"__none__"})
    ))).scalars().all())
    team_by_org = {row.org_id: row for row in report_rows}
    personal = _latest_personal(list((await session.execute(select(models.DailyReport).where(
        models.DailyReport.date == day,
        models.DailyReport.period_type == period_type,
        models.DailyReport.org_id.in_(set(org_by_id) or {"__none__"})
    ))).scalars().all()))
    personal_by_org: dict[str, list[models.DailyReport]] = {}
    for report in personal:
        personal_by_org.setdefault(str(report.org_id), []).append(report)
    users = list((await session.execute(select(models.User).where(
        models.User.is_active.is_(True),
        models.User.org_id.in_(set(org_by_id) or {"__none__"})
    ))).scalars().all())
    user_counts: dict[str, int] = {}
    for user in users:
        user_counts[str(user.org_id)] = user_counts.get(str(user.org_id), 0) + 1
    children: dict[str, list[models.OrgUnit]] = {}
    for org in orgs:
        if org.parent_id in org_by_id:
            children.setdefault(str(org.parent_id), []).append(org)
    parent = {org.id: org.parent_id for org in orgs}
    stale: dict[str, bool] = {}
    for org in sorted(orgs, key=lambda row: _depth(row.id, parent), reverse=True):
        child_orgs = children.get(org.id, [])
        child_reports = [team_by_org[row.id] for row in child_orgs if row.id in team_by_org]
        _, _, _, current_digest = _compose(
            org, personal_by_org.get(org.id, []), child_orgs, child_reports,
            user_counts.get(org.id, 0))
        saved = team_by_org.get(org.id)
        stale[org.id] = (saved is None or saved.source_digest != current_digest or
                         any(stale.get(row.id, True) for row in child_orgs))

    focus = org_by_id[focus_id]
    child_items = []
    for org in children.get(focus_id, []):
        report = team_by_org.get(org.id)
        child_items.append({"org": rbac.org_to_api(org),
                            "report": to_api(report, stale=stale.get(org.id, True))})
    ancestors, current = [], focus
    while current:
        ancestors.append({"id": current.id, "name": current.name})
        current = org_by_id.get(str(current.parent_id or ""))
    ancestors.reverse()

    descendants, stack = set(), [focus_id]
    while stack:
        current_id = stack.pop()
        if current_id in descendants:
            continue
        descendants.add(current_id)
        stack.extend(row.id for row in children.get(current_id, []))
    return {
        "date": day, "period": info, "focusOrgId": focus_id, "breadcrumbs": ancestors,
        "teamReport": to_api(team_by_org.get(focus_id), stale=stale.get(focus_id, True)),
        "orgs": [{**rbac.org_to_api(org),
                  "reportStatus": (team_by_org.get(org.id).status if team_by_org.get(org.id) else "missing"),
                  "needsRefresh": stale.get(org.id, True)} for org in orgs],
        "childTeams": child_items,
        "members": [daily_report.to_api(row) for row in personal_by_org.get(focus_id, [])],
        # Compatibility for older clients: all personal evidence in the selected subtree.
        "reports": [daily_report.to_api(row)
                    for row in personal if str(row.org_id) in descendants],
    }


async def confirm(session: AsyncSession, actor: models.User, report_id: str,
                  note: str = "") -> models.TeamDailyReport:
    report = await session.get(models.TeamDailyReport, report_id)
    if report is None:
        raise LookupError("团队日报不存在")
    data = await overview(session, actor, report.date, report.org_id, report.period_type)
    current = data.get("teamReport") or {}
    if current.get("needsRefresh"):
        raise ValueError("团队事实已经变化，请先刷新日报再确认")
    report.status = "confirmed"
    report.confirmed_by = actor.id
    report.confirmed_by_name = actor.display_name or actor.username
    report.confirmed_at = datetime.now(timezone.utc)
    report.leader_note = _clip(note, 1000)
    await session.commit()
    await session.refresh(report)
    return report
