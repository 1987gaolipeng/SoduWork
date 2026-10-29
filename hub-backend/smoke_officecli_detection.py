# -*- coding: utf-8 -*-
"""Generic Office engine discovery smoke: no network, no business database."""
from pathlib import Path

from app.services import execution_capabilities as caps


def main() -> int:
    env = {
        "APPDATA": r"C:\Users\tester\AppData\Roaming",
        "LOCALAPPDATA": r"C:\Users\tester\AppData\Local",
        "USERPROFILE": r"C:\Users\tester",
        "ComSpec": r"C:\Windows\System32\cmd.exe",
    }
    expected = str(Path(env["APPDATA"]) / "npm" / "officecli.cmd")
    env["SODUWORK_OFFICECLI"] = expected
    candidates = caps._office_candidates(env)
    assert expected in candidates, candidates
    without_explicit = dict(env)
    without_explicit.pop("SODUWORK_OFFICECLI")
    assert not any(caps._office_candidates(without_explicit)), "global CLI must not be auto-discovered"

    argv = caps._office_probe_argv(expected, env, windows=True)
    assert argv[0] == env["ComSpec"], argv
    assert argv[1:4] == ["/d", "/s", "/c"], argv
    assert expected in argv[-1] and "--version" in argv[-1], argv

    commandline = caps._office_probe_command(expected, env, windows=True)
    assert isinstance(commandline, str), commandline
    assert expected in commandline and commandline.endswith('--version"'), commandline

    direct = caps._office_probe_argv("/usr/local/bin/officecli", {}, windows=False)
    assert direct == ["/usr/local/bin/officecli", "--version"], direct
    direct_command = caps._office_probe_command("/usr/local/bin/officecli", {}, windows=False)
    assert direct_command == direct, direct_command

    old_which, old_version = caps._which, caps._version_argv
    calls = []
    try:
        caps._which = lambda names: r"C:\Python312\python.exe" if "python" in names else ""
        caps._version_argv = lambda argv: (calls.append(argv) or
                                           (True, "python-docx + openpyxl + python-pptx"))
        ok, detail = caps._office_python_version({})
    finally:
        caps._which, caps._version_argv = old_which, old_version
    assert ok and "免费本地引擎" in detail, detail
    assert calls and calls[0][-2] == "-c", calls
    print("generic office capability detection: 11 assertions passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
