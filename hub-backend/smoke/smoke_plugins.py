# -*- coding: utf-8 -*-
"""Plugin regression aggregate with independent domain groups and fixtures.

Run all cases with no arguments, or select --group execution / --case receipts.
Each case uses a separate interpreter and temporary database/object namespace.
"""
import argparse

from plugin_smoke.runner import CASE_MODULES, GROUPS, run_case, run_groups


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    selected = parser.add_mutually_exclusive_group()
    selected.add_argument("--group", choices=tuple(GROUPS), help="run one independent domain group")
    selected.add_argument("--case", choices=tuple(CASE_MODULES), help="run one isolated scenario")
    selected.add_argument("--list", action="store_true", help="list groups and their scenarios")
    args = parser.parse_args(argv)
    if args.list:
        for group, cases in GROUPS.items():
            print(group + ": " + ", ".join(cases))
        return 0
    if args.case:
        return run_case(args.case)
    return run_groups((args.group,) if args.group else GROUPS)


if __name__ == "__main__":
    raise SystemExit(main())
