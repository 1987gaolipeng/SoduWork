# -*- coding: utf-8 -*-
"""Real-process Runner deployment tests for isolated worktrees, checks, rollback, redaction, and
idempotency.
"""
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time

ROOT = tempfile.mkdtemp(prefix="soduwork-deploy-smoke-")
DATA = os.path.join(ROOT, "data")
WORK = os.path.join(ROOT, "work")
os.environ["SODUWORK_DATA_ROOT"] = DATA
os.environ["SMOKE_DEPLOY_SECRET"] = "never-leak-this-value"
# Set DATABASE_URL to the temporary database before importing app.db.
# Offline tests must never inherit a configured business database connection.
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///" +
                      os.path.join(ROOT, "smoke.db").replace("\\", "/"))
sys.path.insert(0, ".")

from app.services import ai_remote, runner_deploy, runner_hub  # noqa: E402

ok = fail = 0
lines = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        lines.append("  PASS  " + name)
    else:
        fail += 1
        lines.append("  FAIL  " + name + ("  << " + str(extra)[:240] if extra else ""))


def rm_tree(path):
    def unlock(func, target, _exc):
        os.chmod(target, stat.S_IWRITE)
        func(target)
    shutil.rmtree(path, onerror=unlock)


def git(cwd, *args):
    p = subprocess.run(["git", *args], cwd=cwd, stdin=subprocess.DEVNULL,
                       capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=120)
    if p.returncode:
        raise RuntimeError((p.stdout or "") + (p.stderr or ""))
    return (p.stdout or "").strip()


def wait(run_id, timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        out = runner_deploy.status(run_id)
        if out.get("state") in ("succeeded", "failed", "rolled_back", "rollback_failed"):
            return out
        time.sleep(0.1)
    return runner_deploy.status(run_id)


try:
    ready = runner_deploy.preflight({
        "argv": [sys.executable],
        "secrets": [{"env": "DEPLOY_TOKEN", "locator": "SMOKE_DEPLOY_SECRET"}],
    }, WORK)
    chk("部署前探针能确认工作目录、命令与密钥引用已经就位",
        ready.get("ok") is True and ready.get("workRootSet") is True
        and ready.get("commandState") == "available"
        and ready.get("secrets", [{}])[0].get("present") is True, ready)
    chk("部署前探针绝不回传密钥明文",
        "never-leak-this-value" not in repr(ready), ready)
    missing = runner_deploy.preflight({
        "argv": ["soduwork-command-that-does-not-exist"],
        "secrets": [{"env": "TOKEN", "locator": "SODUWORK_MISSING_SMOKE_SECRET"}],
    }, "")
    chk("部署前探针会一次说清工作目录、命令和密钥缺项",
        missing.get("ok") is False and missing.get("workRootSet") is False
        and missing.get("commandState") == "missing"
        and missing.get("secrets", [{}])[0].get("present") is False
        and len(missing.get("error", "").split("；")) == 3, missing)

    class _Ws:
        async def send_json(self, _msg):
            return None

    old_runners = dict(runner_hub._RUNNERS)
    runner_hub._RUNNERS.clear()
    mine = runner_hub._Runner(_Ws(), {"runnerId": "mine", "host": "mine",
        "clientId": "client-a", "tags": ["linux", "test"],
        "agents": [{"key": "pi"}]})
    foreign = runner_hub._Runner(_Ws(), {"runnerId": "foreign", "host": "foreign",
        "clientId": "client-b", "tags": ["linux", "production"],
        "agents": [{"key": "pi"}]})
    # Connection fixtures must reflect the accepting state restored from the registry before welcome.
    mine.dispatch_mode = foreign.dispatch_mode = "accepting"
    mine.ready = foreign.ready = True
    mine.inventory_ready = foreign.inventory_ready = True
    runner_hub._RUNNERS.update({mine.id: mine, foreign.id: foreign})
    chk("任务优先选择归属人的在线执行机",
        runner_hub.pick_for("client-a", "pi", {"client-a", "client-b"}) is mine)
    chk("执行机选择严格限制在当前组织的客户端集合",
        runner_hub.pick_for("client-a", "pi", {"client-b"}) is foreign
        and runner_hub.pick_for("client-a", "pi", set()) is None)
    chk("环境标签与组织边界会同时生效",
        runner_hub.pick_by_tags(["production"], allowed_client_ids={"client-a"}) is None
        and runner_hub.pick_by_tags(["production"], allowed_client_ids={"client-b"}) is foreign)
    listed = ai_remote.list_assignees_sync({"allowedClients": ["client-a"]})["agents"]
    chk("AI 收件人清单不暴露别的组织的执行机",
        listed and {x.get("clientId") for x in listed} == {"client-a"}, listed)
    runner_hub._RUNNERS.clear()
    runner_hub._RUNNERS.update(old_runners)

    origin = os.path.join(ROOT, "origin.git")
    seed = os.path.join(ROOT, "seed")
    os.makedirs(seed)
    git(ROOT, "init", "--bare", origin)
    git(seed, "init", "-q", "-b", "main")
    with open(os.path.join(seed, "README.md"), "w", encoding="utf-8") as f:
        f.write("deploy smoke")
    git(seed, "add", "-A")
    git(seed, "-c", "user.name=smoke", "-c", "user.email=smoke@local",
        "commit", "-q", "-m", "init")
    git(seed, "remote", "add", "origin", origin)
    git(seed, "push", "-q", "origin", "main")
    commit = git(seed, "rev-parse", "HEAD")

    script = ("import os; open('deployed.txt','w',encoding='utf-8').write('ok'); "
              "print('token=' + os.environ['DEPLOY_TOKEN']); "
              "print('git=' + os.environ['SODUWORK_GIT_TOKEN'])")
    spec = {
        "runId": "smoke-deploy-success", "repoId": "repo-one", "gitUrl": origin,
        "branch": "main", "environmentKey": "test", "commit": commit[:7],
        "argv": [sys.executable, "-c", script], "timeoutSeconds": 30,
        "git": {"name": "发布人", "email": "release@example.com",
                "user": "release", "token": "never-leak-git-token"},
        "env": {}, "secrets": [{"env": "DEPLOY_TOKEN", "provider": "runner-env",
                                  "locator": "SMOKE_DEPLOY_SECRET"}],
        "checks": [{"type": "command", "name": "产物检查",
                    "argv": [sys.executable, "-c",
                             "import os,sys; sys.exit(0 if os.path.isfile('deployed.txt') else 1)"],
                    "timeoutSeconds": 10}],
        "rollback": {"mode": "automatic", "argv": [sys.executable, "-c", "print('rollback')"]},
    }
    started = runner_deploy.start(spec, WORK)
    done = wait(spec["runId"])
    deploy_dir = os.path.join(WORK, ".soduwork-deploy", "repo-one", "test")
    chk("部署异步接单并在专用工作树成功完成",
        started.get("ok") and done.get("state") == "succeeded"
        and os.path.isfile(os.path.join(deploy_dir, "deployed.txt")), done)
    chk("健康检查结果被持久记录",
        (done.get("result") or {}).get("checks", [{}])[0].get("ok") is True, done.get("result"))
    chk("Runner 日志自动脱敏，不回传密钥明文",
        "never-leak-this-value" not in done.get("log", "")
        and "never-leak-git-token" not in done.get("log", "")
        and "token=***" in done.get("log", "") and "git=***" in done.get("log", ""),
        done.get("log", "")[-300:])
    # Deployment worktrees are intentionally reused. Changing the configured
    # source must also change origin; otherwise the next fixed commit is looked
    # up in the previous mirror and fails with "reference is not a tree".
    origin2 = os.path.join(ROOT, "origin-two.git")
    seed2 = os.path.join(ROOT, "seed-two")
    os.makedirs(seed2)
    git(ROOT, "init", "--bare", origin2)
    git(seed2, "init", "-q", "-b", "main")
    with open(os.path.join(seed2, "README.md"), "w", encoding="utf-8") as f:
        f.write("second origin")
    git(seed2, "add", "-A")
    git(seed2, "-c", "user.name=smoke", "-c", "user.email=smoke@local",
        "commit", "-q", "-m", "second")
    git(seed2, "remote", "add", "origin", origin2)
    git(seed2, "push", "-q", "origin", "main")
    commit2 = git(seed2, "rev-parse", "HEAD")
    switched_spec = {
        **spec, "runId": "smoke-deploy-origin-change", "gitUrl": origin2,
        "commit": commit2,
        "argv": [sys.executable, "-c",
                  "open('origin-switched.txt','w').write('two')"],
        "checks": [{"type": "command", "name": "origin switch",
                    "argv": [sys.executable, "-c",
                             "import os,sys; sys.exit(0 if os.path.isfile('origin-switched.txt') else 1)"],
                    "timeoutSeconds": 10}],
    }
    runner_deploy.start(switched_spec, WORK)
    switched = wait(switched_spec["runId"])
    switched_dir = os.path.join(WORK, ".soduwork-deploy", "repo-one", "test")
    chk("deployment worktree syncs origin after repository URL changes",
        switched.get("state") == "succeeded"
        and os.path.isfile(os.path.join(switched_dir, "origin-switched.txt"))
        and git(switched_dir, "config", "--get", "remote.origin.url") == origin2,
        switched)
    second = runner_deploy.start(spec, WORK)
    chk("同一运行号重复启动幂等", second.get("state") == "succeeded")

    fail_spec = {**spec, "runId": "smoke-deploy-rollback", "environmentKey": "production",
                 "checks": [{"type": "command", "name": "故意失败",
                             "argv": [sys.executable, "-c", "raise SystemExit(3)"],
                             "timeoutSeconds": 10}],
                 "rollback": {"mode": "automatic",
                              "argv": [sys.executable, "-c",
                                       "open('rolled-back.txt','w').write('yes')"]}}
    runner_deploy.start(fail_spec, WORK)
    rolled = wait(fail_spec["runId"])
    prod_dir = os.path.join(WORK, ".soduwork-deploy", "repo-one", "production")
    chk("健康检查失败会按策略自动回滚并留下明确状态",
        rolled.get("state") == "rolled_back"
        and os.path.isfile(os.path.join(prod_dir, "rolled-back.txt")), rolled)

    prepare_fail = {
        **spec, "runId": "smoke-deploy-prepare-fail", "environmentKey": "prepare-fail",
        "commit": "0" * 40,
        "rollback": {"mode": "automatic", "argv": [
            sys.executable, "-c", "open('must-not-rollback.txt','w').write('bad')"]},
    }
    runner_deploy.start(prepare_fail, WORK)
    prepare_failed = wait(prepare_fail["runId"])
    prepare_dir = os.path.join(WORK, ".soduwork-deploy", "repo-one", "prepare-fail")
    chk("获批版本或仓库准备失败时绝不触碰生产回滚点",
        prepare_failed.get("state") == "failed" and prepare_failed.get("stage") == "prepare"
        and not os.path.exists(os.path.join(prepare_dir, "must-not-rollback.txt")), prepare_failed)

    rejected = False
    try:
        runner_deploy.start({**spec, "runId": "smoke-deploy-bad", "argv": "echo unsafe"}, WORK)
        bad = wait("smoke-deploy-bad")
        rejected = bad.get("state") == "rolled_back" or "参数数组" in bad.get("error", "")
    except ValueError:
        rejected = True
    chk("部署执行器不接受 shell 字符串", rejected)
finally:
    rm_tree(ROOT)

print("\n".join(lines))
print(f"\ndeploy smoke: {ok} passed, {fail} failed")
raise SystemExit(1 if fail else 0)
