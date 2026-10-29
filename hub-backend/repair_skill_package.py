"""Inspect a legacy Skill offline; --output writes a separate validated .skill.

Examples (from hub-backend):
  .venv/Scripts/python.exe repair_skill_package.py D:/exports/debug-radar.skill
  .venv/Scripts/python.exe repair_skill_package.py D:/exports/debug-radar.skill --output D:/exports/debug-radar-fixed.skill

The output must be imported through the normal Skill installation flow. This
command does not enable it, alter the installed version, or update any cache.
"""
from __future__ import annotations

import argparse
import json
import sys

from app.services.skill_frontmatter_repair import prepare


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="离线诊断旧 Skill 的 description YAML 错误；默认不写入")
    parser.add_argument("source", help="单个 Skill 目录或 .skill/.zip 包")
    parser.add_argument("--output", help="生成一个独立的新 .skill 文件；不覆盖原文件或已存在文件")
    args = parser.parse_args(argv)
    try:
        plan = prepare(args.source)
        result = plan.report()
        if args.output:
            result["output"] = str(plan.write(args.output))
    except (OSError, ValueError) as exc:
        print(json.dumps({"status": "rejected", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
