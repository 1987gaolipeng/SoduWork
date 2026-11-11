"""Regression checks for public module contracts."""
from __future__ import annotations
from pathlib import Path

import asyncio
import http.server
import os
import subprocess
import sys
import tempfile
import threading
from unittest.mock import patch

sys.path.insert(0, ".")

from app.services import local_base, local_stream  # noqa: E402

passed = failed = 0


def ok(cond, name, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("  PASS ", name)
    else:
        failed += 1
        print("  FAIL ", name, " << ", str(detail)[:300])


def directory_link(link, target):
    if os.name == "nt":
        subprocess.run(["cmd", "/d", "/c", "mklink", "/J", link, target],
                       capture_output=True, timeout=30, check=True)
    else:
        os.symlink(target, link, target_is_directory=True)


def t_codex_home() -> None:
    with tempfile.TemporaryDirectory() as temp:
        home = os.path.join(temp, "codex-home")
        skills = os.path.join(home, "skills")
        real = os.path.join(skills, "real-skill")
        os.makedirs(real)
        with open(os.path.join(real, "SKILL.md"), "w", encoding="utf-8") as f:
            f.write("keep me")
        target = os.path.join(temp, "target")
        os.makedirs(target)
        with open(os.path.join(target, "payload.txt"), "w", encoding="utf-8") as f:
            f.write("target content")
        link = os.path.join(skills, "linked")
        directory_link(link, target)
        local_base._prepare_codex_home({"CODEX_HOME": home})
        ok(not os.path.lexists(link), "★junction 被摘除（codex 4395 的病根）")
        ok(os.path.isfile(os.path.join(target, "payload.txt")),
           "★只摘链接不跟进去：目标目录内容一根汗毛都没少")
        ok(os.path.isfile(os.path.join(real, "SKILL.md")), "真实技能目录原样保留")
        local_base._prepare_codex_home({"CODEX_HOME": home})
        ok(True, "再跑一遍幂等不炸")
        # Remove the link itself when the skills directory is a link.
        home2 = os.path.join(temp, "codex-home-2")
        os.makedirs(home2)
        link2 = os.path.join(home2, "skills")
        directory_link(link2, target)
        local_base._prepare_codex_home({"CODEX_HOME": home2})
        ok(not os.path.lexists(link2) and os.path.isfile(os.path.join(target, "payload.txt")),
           "skills 目录本身是链接：摘链接、目标无恙")


def t_codex_temp_boundary() -> None:
    """Every Codex conversation gets isolated state and only imports login."""
    with tempfile.TemporaryDirectory() as temp:
        home = os.path.join(temp, "codex-source")
        data = os.path.join(temp, "soduwork-data")
        work = os.path.join(temp, "work-root")
        os.makedirs(home)
        Path(home, "auth.json").write_text('{"auth_mode":"test"}', encoding="utf-8")
        Path(home, "config.toml").write_text("personal_hook = true", encoding="utf-8")
        old = os.environ.get("CODEX_HOME")
        old_data = os.environ.get("SODUWORK_DATA_ROOT")
        os.environ["CODEX_HOME"] = home
        os.environ["SODUWORK_DATA_ROOT"] = data
        try:
            codex_env = local_base._env_for(
                local_base._PROFILES["codex"], {"local_workspace_root": work},
                runtime_ref="../chat:one")
            runtime_home = codex_env.get("CODEX_HOME") or ""
            ok(codex_env.get("PYTHONUTF8") == "1"
               and codex_env.get("PYTHONIOENCODING") == "utf-8",
               "Runner 子进程统一使用 UTF-8，不继承 Windows 本地代码页")
            expected = os.path.join(runtime_home, ".soduwork-tmp")
            ok(os.path.commonpath([runtime_home, data]) == os.path.abspath(data),
               "Codex 会话目录固定在 SoduWork 私有数据根内", runtime_home)
            ok(codex_env.get("TEMP") == expected
               and codex_env.get("TMP") == expected
               and codex_env.get("TMPDIR") == expected,
               "Codex 内部临时文件与 CODEX_HOME 保持同一存储边界", codex_env.get("TEMP"))
            ok(os.path.isdir(expected), "Codex 私有临时目录已准备")
            ok(Path(runtime_home, "auth.json").read_text(encoding="utf-8")
               == '{"auth_mode":"test"}', "仅同步 Codex 登录状态")
            ok(not Path(runtime_home, "config.toml").exists(),
               "不继承个人 hooks、MCP 和运行配置")
            again = local_base._env_for(
                local_base._PROFILES["codex"], {"local_workspace_root": work},
                runtime_ref="../chat:one")
            ok(again.get("CODEX_HOME") == runtime_home, "同一会话续聊复用同一 Codex 状态目录")

            pi_env = local_base._env_for(
                local_base._PROFILES["pi"], {"local_workspace_root": work})
            ok(pi_env.get("TEMP") == os.path.join(work, "temp"),
               "其他底座仍严格使用用户设定工作根下的 temp", pi_env.get("TEMP"))
        finally:
            if old is None:
                os.environ.pop("CODEX_HOME", None)
            else:
                os.environ["CODEX_HOME"] = old
            if old_data is None:
                os.environ.pop("SODUWORK_DATA_ROOT", None)
            else:
                os.environ["SODUWORK_DATA_ROOT"] = old_data


def t_noise() -> None:
    line = ("Warning: No project session found with id "
            "'5a4c60ff-bb55-4cff-afb2-32160acd19e0'; creating a new session with that id.")
    ok(bool(local_stream._EXPECTED_NOISE.search(line)),
       "★pi 首轮会话提示被认定为预期噪音（不进实况、raw.log 照留）")
    ok(not local_stream._EXPECTED_NOISE.search("Error: session corrupted"),
       "真错误不在噪音名单里")

def t_remote_reinjection() -> None:
    """Completed Runner sessions receive fresh credentials for each follow-up."""
    from app.services import ai_remote, runner_hub

    class _Runner:
        id = "secret-boundary-runner"
        host = "安全执行机"

    runner = _Runner()
    ref = "secret-boundary-ref"
    captured = {}
    real_get = runner_hub.get
    real_call = runner_hub.call_sync
    runner_hub.get = lambda rid: runner if rid == runner.id else None

    def fake_call(target, op, data, timeout=60):
        captured.update({"target": target, "op": op, "data": data})
        return {"ok": True, "data": {"ok": True}}

    runner_hub.call_sync = fake_call
    ai_remote._WHERE[ref] = runner.id
    try:
        cfg = {"llm": {"key": "fresh-model-key"}, "git": {"token": "fresh-git-token"}}
        result = ai_remote.comment_sync(cfg, ref, "继续完成")
        ok(result.get("ok") is True and captured.get("op") == "job.comment",
           "远程续聊仍走原执行机", captured)
        ok(captured.get("data", {}).get("cfg") == cfg,
           "★每轮续聊重新下发当轮授权配置，不依赖结束会话里的旧密钥", captured)
        from runner_main import Runner
        from app.services import ai_local, runtime_images
        forwarded = []
        with tempfile.TemporaryDirectory(prefix="soduwork-turn-cfg-") as store:
            for index in range(2):
                current = {"llm": {"key": "synthetic-turn-%d" % index}}
                admission = "comment:smoke-%d" % index
                prepared = {**current, "_admissionKey": admission, "_inputImages": []}
                message = {"op": "job.comment", "ref": ref, "text": "continue",
                           "turnId": "smoke-%d" % index, "cfg": current,
                           "_admitted": True, "_admissionKey": admission}
                with patch.object(ai_local, "_store_dir", return_value=store), \
                        patch.object(runtime_images, "prepare", return_value=prepared) as images, \
                        patch.object(local_stream, "comment_sync", return_value={"ok": True}) as comment:
                    result = asyncio.run(Runner._job(object.__new__(Runner), message))
                forwarded.append(result.get("ok") is True and
                    images.call_args.args == ({**current, "_admissionKey": admission},
                                              [], os.path.join(store, "inputs")) and
                    comment.call_args.args == (prepared, ref, "continue") and
                    comment.call_args.args[0] is prepared and "_admissionKey" not in current)
        ok(all(forwarded), "★Runner 每轮把新授权及准备结果交给续聊执行器，保留队列身份")
    finally:
        runner_hub.get = real_get
        runner_hub.call_sync = real_call
        ai_remote._WHERE.pop(ref, None)


def t_reclaimed_model_authorization() -> None:
    """A live reclaimed run can recover a grant without persisting the secret."""
    ref = "smoke-reclaimed-managed-model"
    original = local_base._RUNS.get(ref)
    local_base._RUNS[ref] = {
        "cli": "codex-harness", "state": "running", "cfg": {},
    }
    try:
        ok(local_stream.authorization_required_sync(ref),
           "重启认领的托管模型会话会声明需要恢复临时授权")
        cfg = {
            "local_cli": "codex-harness",
            "requiredCapabilities": ["terminal", "files"],
            "llm": {"base": "http://model.invalid", "key": "ephemeral-secret",
                    "model": "dev-think-large-agent-soduwork"},
        }
        restored = local_stream.authorize_sync(cfg, ref)
        ok(restored.get("ok") and restored.get("accepted"),
           "本机私有控制通道可把短期模型授权恢复到内存", restored)
        ok(not local_stream.authorization_required_sync(ref),
           "授权恢复后不会重复索要")
        ok(local_base._RUNS[ref].get("cfg", {}).get("requiredCapabilities") ==
           ["terminal", "files"], "续轮同时保留原执行能力授权")
        local_base._RUNS[ref]["state"] = "done"
        ignored = local_stream.authorize_sync(cfg, ref)
        ok(ignored.get("ok") and not ignored.get("accepted"),
           "已结束会话不缓存多余密钥", ignored)
        source = Path("runner_main.py").read_text(encoding="utf-8")
        ok('if not m.get("_localParent")' in source and '"job.authorize"' in source,
           "再授权接口只开放给本机父子控制通道")
    finally:
        if original is None:
            local_base._RUNS.pop(ref, None)
        else:
            local_base._RUNS[ref] = original


def t_runner_log_boundary() -> None:
    """Runner logs identify events without serializing their full payload."""
    source = Path("app/api/runner_ws.py").read_text(encoding="utf-8")
    ok('str(msg)[:200]' not in source,
       "Runner event logs never serialize the full protocol payload", source[-500:])
    ok('runner event id=%s type=%s ref=%s' in source,
       "Runner event logs retain safe correlation fields", source[-500:])


def t_gateway() -> None:
    ok(local_stream._llm_gate_check({"needs_llm": False}, {"llm": {"base": "http://x"}}) == "",
       "自带账号的底座（codex/claude）不做网关预检")
    ok(local_stream._llm_gate_check({"needs_llm": True}, {}) == "",
       "没配网关不预检（配置校验另有人管）")
    msg = local_stream._llm_gate_check(
        {"needs_llm": True}, {"llm": {"base": "http://127.0.0.1:9/v1"}})
    ok("127.0.0.1" in msg and "直连" in msg and "网络" in msg,
       "★连不上网关：开跑前就用人话拦下（不烧一半再报天书）", msg)

    class _H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            self.send_response(404)
            self.end_headers()

        def log_message(self, *a):  # noqa: D102
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), _H)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        base = "http://127.0.0.1:%d/v1" % server.server_address[1]
        ok(local_stream._llm_gate_check({"needs_llm": True}, {"llm": {"base": base}}) == "",
           "网关有 HTTP 响应（哪怕 404）＝网络通，放行")
    finally:
        server.shutdown()


if __name__ == "__main__":
    t_codex_home()
    t_codex_temp_boundary()
    t_noise()
    t_remote_reinjection()
    t_reclaimed_model_authorization()
    t_runner_log_boundary()
    t_gateway()
    print(f"local env guards smoke: {passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
