"""Fill optional per-locale copies for the four default automation templates.

The organization catalog lives in AppSetting `automation_templates_v1` and
predates the nameLocales/descriptionLocales/noteLocales fields. Employees on
non-Chinese UIs used to see the base Chinese text on the Automation page and in
the prefilled create form. This script fills approved translations for the
well-known product defaults.

Safety contract:
- Matches templates by their EXACT current Chinese name; only fills description
  /note translations when the base text still equals the product default. Any
  template the administrator has since customized is left untouched and
  reported, never guessed at.
- Only fills locale keys that are missing or empty; existing values are never
  overwritten. Re-running is a no-op once everything is filled.

Run inside hub-backend's environment (same DATABASE_URL as the Hub service):

    python backfill_automation_template_locales.py [--dry-run]
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.db import SessionLocal, engine  # noqa: E402
from app.services import automation_templates  # noqa: E402

# Approved translations for the four product defaults. Names/descriptions reuse
# the exact strings already shipped in the client locale catalogs; notes were
# translated for this backfill (they only lived in form textareas before).
DEFAULT_TEMPLATES = {
    "每日工作总结": {
        "nameLocales": {
            "en-US": "Daily work summary", "ja-JP": "毎日の作業まとめ", "ko-KR": "매일 작업 요약",
        },
        "description": "每天整理今日任务、风险和明日计划",
        "descriptionLocales": {
            "en-US": "Summarize today’s work, risks and tomorrow’s plan each day",
            "ja-JP": "今日の課題・リスク・翌日計画を毎日整理",
            "ko-KR": "매일 오늘 이슈, 리스크, 내일 계획 정리",
        },
        "note": "汇总我今天的任务进展、成果、风险和明日计划，输出结构清晰的工作简报。",
        "noteLocales": {
            "en-US": "Summarize today's task progress, results, risks, and tomorrow's plan; "
                     "output a clearly structured work briefing.",
            "ja-JP": "今日のタスクの進捗・成果・リスクと翌日の計画を整理し、構成の明確な業務ブリーフィングを出力する。",
            "ko-KR": "오늘의 작업 진행 상황, 성과, 리스크, 내일 계획을 정리해 구조가 명확한 업무 브리핑을 작성한다.",
        },
    },
    "每周团队简报": {
        "nameLocales": {
            "en-US": "Weekly team brief", "ja-JP": "週次チームブリーフ", "ko-KR": "주간 팀 브리핑",
        },
        "description": "聚合本周进展、风险与下周重点",
        "descriptionLocales": {
            "en-US": "Summarize this week’s progress, risks and next week’s priorities",
            "ja-JP": "今週の進捗・リスク・来週の重点を集約",
            "ko-KR": "이번 주 진행, 리스크, 다음 주 중점 집계",
        },
        "note": "整理本周完成事项、关键成果、阻塞风险和下周优先级，形成可直接阅读的团队简报。",
        "noteLocales": {
            "en-US": "Collect this week's completed items, key results, blocking risks, and next "
                     "week's priorities into a team briefing that reads as-is.",
            "ja-JP": "今週完了した事項・主要な成果・障害となっているリスク・来週の優先度を整理し、そのまま読めるチームブリーフを作成する。",
            "ko-KR": "이번 주 완료 항목, 핵심 성과, 장애 리스크, 다음 주 우선순위를 정리해 바로 읽을 수 있는 팀 브리핑을 만든다.",
        },
    },
    "网页巡检": {
        "nameLocales": {
            "en-US": "Website checks", "ja-JP": "Web 巡回チェック", "ko-KR": "웹 순회 점검",
        },
        "description": "按时检查页面、关键数据和异常证据",
        "descriptionLocales": {
            "en-US": "Check pages, key data and evidence of issues on schedule",
            "ja-JP": "ページ・重要データ・異常の証拠を定時にチェック",
            "ko-KR": "정시에 페이지, 핵심 데이터, 이상 증거 검사",
        },
        "note": "打开目标网页，检查可用性、关键数据和异常；保留截图或结果证据，并输出巡检结论。",
        "noteLocales": {
            "en-US": "Open the target pages, check availability, key data and anomalies; keep "
                     "screenshots or result evidence and output an inspection conclusion.",
            "ja-JP": "対象ページを開き、可用性・主要データ・異常を確認する。スクリーンショットや結果の証拠を残し、巡回チェックの結論を出力する。",
            "ko-KR": "대상 페이지를 열어 가용성, 핵심 데이터, 이상 여부를 확인하고, 스크린샷이나 결과 증거를 남기며 점검 결론을 작성한다.",
        },
    },
    "业务系统办理": {
        "nameLocales": {
            "en-US": "Business system tasks", "ja-JP": "業務システム処理", "ko-KR": "업무 시스템 처리",
        },
        "description": "定时填报工时、处理 OA 或其他网页事务",
        "descriptionLocales": {
            "en-US": "Schedule timesheets, office workflows or other web tasks",
            "ja-JP": "工数入力や OA 処理などの Web 作業を定時実行",
            "ko-KR": "정시에 공수 입력, OA 처리 등 웹 업무 처리",
        },
        "note": "打开指定业务系统，按明确规则完成待办或填报；遇到高风险操作时停下等待人工确认，保留操作回执。",
        "noteLocales": {
            "en-US": "Open the specified business system and complete to-dos or submissions by "
                     "explicit rules; pause for human confirmation on high-risk operations and keep the receipts.",
            "ja-JP": "指定された業務システムを開き、明確なルールに従ってToDoや入力を完了する。高リスクの操作では人間の確認を待って停止し、操作記録を残す。",
            "ko-KR": "지정된 업무 시스템을 열어 명확한 규칙에 따라 할 일과 입력을 완료한다. 고위험 작업은 사람의 확인을 기다리며 중단하고, 조작 증빙을 남긴다.",
        },
    },
}


def merge_locales(existing: dict | None, additions: dict) -> tuple[dict, list[str]]:
    """Only fill keys that are missing or empty; never overwrite. Returns (map, filled)."""
    merged = dict(existing or {})
    filled = [loc for loc, text in additions.items() if not str(merged.get(loc) or "").strip()]
    for loc in filled:
        merged[loc] = additions[loc]
    return merged, filled


def plan(item: dict) -> tuple[dict, list[str]]:
    """Return ({field: locales map}, report lines) for one template, or ({}, [])."""
    spec = DEFAULT_TEMPLATES.get(str(item.get("name") or ""))
    if not spec:
        return {}, []
    updates: dict = {}
    report: list[str] = []
    merged, filled = merge_locales(item.get("nameLocales"), spec["nameLocales"])
    if filled:
        updates["nameLocales"] = merged
        report.append("name+" + ",".join(filled))
    for field in ("descriptionLocales", "noteLocales"):
        base_field = field[:-7]  # "description" / "note"
        base = str(item.get(base_field) or "").strip()
        if base != spec[base_field]:
            # Customized (or empty) base text: keep the administrator's words,
            # never guess a translation for copy we have not reviewed.
            if base:
                report.append(f"{base_field} customized, skipped")
            continue
        merged, filled = merge_locales(item.get(field), spec[field])
        if filled:
            updates[field] = merged
            report.append(base_field + "+" + ",".join(filled))
    return updates, report


async def main(dry_run: bool) -> None:
    async with SessionLocal() as session:
        items = await automation_templates.load(session)
        merged_items = []
        touched = 0
        for item in items:
            updates, report = plan(item)
            if not updates:
                merged_items.append(dict(item))
                continue
            touched += 1
            print(("[dry-run] " if dry_run else "") + f"{item['name']}: " + "; ".join(report))
            updated = dict(item)
            updated.pop("updatedAt", None)  # let normalize stamp the edit time
            updated.update(updates)
            merged_items.append(updated)
        if touched and not dry_run:
            await automation_templates.save(session, merged_items)
            await session.commit()
        if not touched:
            print("nothing to fill: no matching default templates or already up to date")
        else:
            print(f"{'would update' if dry_run else 'updated'} {touched} template(s); "
                  f"{len(items) - touched} left untouched")
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main("--dry-run" in sys.argv))
