"""Regression checks for SoduWork-managed OpenCode installation."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.services import agent_setup, managed_agents


def main() -> None:
    assert managed_agents.OPENCODE_VERSION == "1.18.18"
    assert agent_setup._SPECS["opencode"]["installer"] == "managed"

    with (
        patch("platform.system", return_value="Windows"),
        patch("platform.machine", return_value="AMD64"),
        patch.object(managed_agents, "_has_avx2", return_value=False),
    ):
        assert managed_agents.platform_key() == "windows-x64-baseline"

    with tempfile.TemporaryDirectory() as temp:
        executable = Path(temp) / "opencode.exe"
        executable.write_bytes(b"fixture")
        with patch.dict(
            os.environ, {"SODUWORK_BUNDLED_OPENCODE": str(executable)}, clear=False
        ):
            with patch.object(managed_agents, "managed_binary", return_value=""):
                # A stale environment from an older client never restores the
                # retired bundled path or suppresses the explicit install action.
                assert managed_agents.opencode_binary() == ""
                assert not agent_setup.is_bundled("opencode")

    # Prefer explicit mirrors, then the connected Hub, then GitHub; without configuration, use GitHub only.
    clean_env = {"SODUWORK_OPENCODE_RELEASE_BASE": "", "SODUWORK_HUB_HTTP_BASE": ""}
    with patch.dict(os.environ, clean_env, clear=False):
        assert managed_agents._release_bases() == [managed_agents._RELEASE_BASE]
    with patch.dict(os.environ, {**clean_env, "SODUWORK_HUB_HTTP_BASE": "http://hub:9080/"}, clear=False):
        assert managed_agents._release_bases() == [
            "http://hub:9080/api/v1/download/opencode", managed_agents._RELEASE_BASE]
    with patch.dict(os.environ, {
        "SODUWORK_OPENCODE_RELEASE_BASE": "https://mirror.corp/opencode/",
        "SODUWORK_HUB_HTTP_BASE": "http://hub:9080",
    }, clear=False):
        assert managed_agents._release_bases() == [
            "https://mirror.corp/opencode",
            "http://hub:9080/api/v1/download/opencode", managed_agents._RELEASE_BASE]

    # runner_main converts the --hub ws(s) URL to http(s) and sets SODUWORK_HUB_HTTP_BASE only if absent.
    runner_source = (Path(managed_agents.__file__).parents[2] / "runner_main.py") \
        .read_text(encoding="utf-8")
    assert 'setdefault("SODUWORK_HUB_HTTP_BASE"' in runner_source

    # Try download sources in order until one succeeds; report the final cause if every source fails.
    calls: list[str] = []

    def _fake_download(url, target, expected, say):
        calls.append(url)
        if "mirror.corp" in url:
            raise RuntimeError("mirror down")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"ok")

    with tempfile.TemporaryDirectory() as temp:
        with (
            patch.dict(os.environ, {
                "SODUWORK_OPENCODE_RELEASE_BASE": "https://mirror.corp/opencode",
                "SODUWORK_HUB_HTTP_BASE": "http://hub:9080",
            }, clear=False),
            patch("platform.system", return_value="Windows"),
            patch("platform.machine", return_value="AMD64"),
            patch.object(managed_agents, "sys", SimpleNamespace(platform="win32")),
            patch.object(managed_agents, "_has_avx2", return_value=False),
            patch.object(managed_agents, "binary_version", return_value=""),
            patch.object(managed_agents, "_root", return_value=Path(temp)),
            patch.object(managed_agents, "_download", _fake_download),
            patch.object(managed_agents, "_extract_binary",
                         side_effect=RuntimeError("stop after download")),
        ):
            try:
                managed_agents.install("install", lambda line: None)
            except RuntimeError as exc:
                assert "stop after download" in str(exc)
            else:
                raise AssertionError("the download fixture must stop before activation")
            assert len(calls) == 2, calls
            assert calls[0].startswith("https://mirror.corp/opencode/")
            assert calls[1].startswith("http://hub:9080/api/v1/download/opencode/")

    # The Windows download fixture must not bypass the real Linux CPU guard.
    # Feed the guard deterministic /proc content; unsupported hosts must fail
    # before probing/executing any binary or downloading a package.
    with (
        patch.object(managed_agents, "sys", SimpleNamespace(platform="linux")),
        patch("platform.machine", return_value="x86_64"),
        patch.object(Path, "read_text", return_value="flags : sse sse2\n") as cpuinfo,
        patch.object(managed_agents, "binary_version") as version,
        patch.object(managed_agents, "_download") as download,
    ):
        problem = managed_agents._cpu_compatibility_issue()
        assert "SSSE3" in problem
        assert managed_agents.install("check", lambda _: None) == (False, problem)
        try:
            managed_agents.install("install", lambda _: None)
        except RuntimeError as exc:
            assert str(exc) == problem
        else:
            raise AssertionError("unsupported CPU must reject installation")
        version.assert_not_called()
        download.assert_not_called()
        cpuinfo.return_value = "flags : sse sse2 ssse3\n"
        assert managed_agents._cpu_compatibility_issue() == ""

    source = Path(managed_agents.__file__).read_text(encoding="utf-8")
    assert "\ufffd" not in source
    assert "????" not in source
    print("smoke_managed_agents: platform/download/CPU guard assertions passed")


if __name__ == "__main__":
    main()
