"""Compatibility import; work_report owns the daily and weekly report implementation."""

from .work_report import (  # noqa: F401
    PERIOD_TYPES,
    REPORT_HOUR,
    WEEKLY_REPORT_HOUR,
    WEEKLY_REPORT_WEEKDAY,
    collect,
    collect_period,
    find_report,
    generate_for,
    period_info,
    render_template,
    report_loop,
    run_for_all,
    shift_anchor,
    to_api,
    today_str,
)

__all__ = [
    "PERIOD_TYPES", "REPORT_HOUR", "WEEKLY_REPORT_HOUR", "WEEKLY_REPORT_WEEKDAY",
    "collect", "collect_period", "find_report", "generate_for", "period_info",
    "render_template", "report_loop", "run_for_all", "shift_anchor", "to_api",
    "today_str",
]
