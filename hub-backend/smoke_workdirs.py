# -*- coding: utf-8 -*-
"""Regression checks for public module contracts."""
import io
import os
import shutil
import stat
import subprocess
import sys
import tempfile

sys.path.insert(0, ".")

SMOKE_DATA = os.path.abspath(".smoke-workdirs-data")
shutil.rmtree(SMOKE_DATA, ignore_errors=True)
os.environ["SODUWORK_DATA_ROOT"] = SMOKE_DATA

from app.services import workdirs  # noqa: E402

ok = fail = 0
log = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        log.append("  PASS  " + name)
    else:
        fail += 1
        log.append("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


def git(cwd, *a):
    return subprocess.run(["git", *a], cwd=cwd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=120,
                          stdin=subprocess.DEVNULL)


class FakeRepo:
    """Match the production Repo shape using only fields read by workspace resolution."""

    def __init__(self, **kw):
        self.id = kw.get("id", "r1")
        self.name = kw.get("name", "示例社区")
        self.local_dir = kw.get("local_dir", "sample-project/sample-project")
        self.git_url = kw.get("git_url", "")
        self.default_branch = kw.get("default_branch", "")
        self.ai_work_dir = kw.get("ai_work_dir", "")


class FakeClient:
    def __init__(self, work_root=""):
        self.id = "u-smoke-wd"
        self.work_root = work_root


def rm_tree(path):
    def unlock(func, target, _exc):
        os.chmod(target, stat.S_IWRITE)
        func(target)
    if os.path.exists(path):
        shutil.rmtree(path, onerror=unlock)


base = tempfile.mkdtemp(prefix="smoke-wd-")
try:
    root = os.path.join(base, "workspace")
    os.makedirs(root, exist_ok=True)

    # Verify temporary work under <root>/temp/<task>_<timestamp>.
    d = workdirs.temp_dir(root, "tms123")
    chk("★临时活落在 <工作目录>/temp 底下",
        os.path.normcase(os.path.dirname(os.path.dirname(d))) == os.path.normcase(root)
        and os.path.basename(os.path.dirname(d)) == "temp", d)
    chk("★目录名带任务号（一眼看得出是哪条活的）", "tms123" in os.path.basename(d), d)
    chk("★★目录是**真建出来**的（用户要求「先创建目录再工作」）", os.path.isdir(d), d)
    d2 = workdirs.temp_dir(root, "tms123")
    chk("同一条活再派一轮 → 另一个干净目录（别把上轮半成品当这轮产出）", d != d2, (d, d2))
    dn = workdirs.temp_dir("", "tms123")
    chk("★没设工作目录时**绝不往用户主目录写**（回落到存档根）",
        os.path.commonpath([os.path.abspath(dn), os.path.abspath(SMOKE_DATA)])
        == os.path.abspath(SMOKE_DATA)
        and os.path.isdir(dn), dn)

    # Clone project work once, then fetch on later attempts.
    origin = os.path.join(base, "origin.git")
    seed = os.path.join(base, "seed")
    os.makedirs(seed, exist_ok=True)
    git(base, "init", "--bare", origin)
    git(seed, "init", "-q", "-b", "main")
    io.open(os.path.join(seed, "README.md"), "w", encoding="utf-8").write("hi")
    git(seed, "add", "-A")
    git(seed, "-c", "user.name=s", "-c", "user.email=s@x", "commit", "-q", "-m", "init")
    git(seed, "remote", "add", "origin", origin)
    git(seed, "push", "-q", "origin", "main")

    repo = FakeRepo(git_url=origin, default_branch="main")
    want = workdirs.repo_dir(root, repo)
    chk("★工程目录 = <工作目录>/<工程子目录>",
        os.path.normcase(want) == os.path.normcase(
            os.path.join(root, "sample-project", "sample-project")), want)

    r = workdirs.plan(root, repo, "tms999")
    chk("★★第一次用这个工程 → 真的 clone 下来了", r["ok"] and r["cloned"], r)
    chk("代码真的在（README 拉下来了）",
        os.path.isfile(os.path.join(want, "README.md")), os.listdir(want)[:5])
    chk("落点就是 <工作目录>/<工程子目录>", os.path.normcase(r["dir"]) == os.path.normcase(want), r)

    r2 = workdirs.plan(root, repo, "tms999")
    chk("★★第二次不再 clone（已经有了就只 fetch，别把人家改到一半的东西冲掉）",
        r2["ok"] and not r2["cloned"], r2)

    # Use the primary clone as a cache and a separate worktree for each workflow attempt.
    isolated = workdirs.plan(
        root, repo, "tms999", execution_key="run-1:scope:1", base_ref="main")
    chk("★★工作流节点使用独立 Git worktree，不直接在主克隆干活",
        isolated["ok"] and isolated.get("isolated") and isolated["dir"] != want,
        isolated)
    chk("隔离工作树锁定远端基线提交",
        git(isolated["dir"], "rev-parse", "HEAD").stdout.strip()
        == git(want, "rev-parse", "origin/main").stdout.strip(), isolated)
    io.open(os.path.join(isolated["dir"], "README.md"), "w", encoding="utf-8").write("changed")
    chk("★★节点改坏自己的副本也不会污染主克隆",
        io.open(os.path.join(want, "README.md"), encoding="utf-8").read() == "hi"
        and not git(want, "status", "--short").stdout.strip())
    isolated_again = workdirs.plan(
        root, repo, "tms999", execution_key="run-1:scope:1", base_ref="main")
    chk("同一个节点尝试重复派发时幂等复用同一 worktree",
        isolated_again["ok"] and isolated_again["dir"] == isolated["dir"], isolated_again)
    isolated_next = workdirs.plan(
        root, repo, "tms999", execution_key="run-1:implement:1", base_ref="main")
    chk("下一节点得到另一份干净 worktree",
        isolated_next["ok"] and isolated_next["dir"] != isolated["dir"]
        and not git(isolated_next["dir"], "status", "--short").stdout.strip(), isolated_next)

    # ---- Add repository hosts to NO_PROXY while preserving proxies for other requests. ----
    seen_env = {}
    real_git = workdirs._git

    def _spy(cwd, args, env=None):
        seen_env.clear()
        seen_env.update(env or {})
        return real_git(cwd, args, env)

    workdirs._git = _spy
    try:
        os.environ["HTTP_PROXY"] = "http://192.0.2.60:18224"      # Simulate system proxy settings in this smoke test.
        gerrit = FakeRepo(id="r9", name="内网 gerrit", local_dir="inner",
                          git_url="http://gerrit.example.com/a/svc")
        workdirs.ensure_repo(os.path.join(root, "inner-clone"), gerrit, None)
        no_proxy = (seen_env.get("NO_PROXY", "") + "," + seen_env.get("no_proxy", "")).lower()
        chk("★★内网仓库 clone 绕代理：仓库 host 进 NO_PROXY（大小写两个都设）",
            "gerrit.example.com" in no_proxy
            and seen_env.get("NO_PROXY") and seen_env.get("no_proxy"),
            {k: seen_env.get(k) for k in ("NO_PROXY", "no_proxy", "HTTP_PROXY")})
        chk("★但 HTTP_PROXY 保留（自带账号的 CLI 还要靠它访问外网）",
            seen_env.get("HTTP_PROXY") == "http://192.0.2.60:18224", seen_env.get("HTTP_PROXY"))
    finally:
        workdirs._git = real_git
        os.environ.pop("HTTP_PROXY", None)

    # Preserve an occupied directory that is not a Git repository.
    busy = FakeRepo(id="r2", name="别人的", local_dir="someone-else", git_url=origin)
    bd = workdirs.repo_dir(root, busy)
    os.makedirs(bd, exist_ok=True)
    io.open(os.path.join(bd, "重要文件.txt"), "w", encoding="utf-8").write("别删我")
    r3 = workdirs.plan(root, busy, "tms888")
    chk("★★目录有东西但不是 git 仓库 → 拒绝，不往里 clone（会盖掉人家的东西）",
        not r3["ok"] and "不是个 git 仓库" in r3["detail"], r3)
    chk("★而且那个文件还在（真的没动）",
        os.path.isfile(os.path.join(bd, "重要文件.txt")))

    # Verify a project without a Git URL.
    nourl = FakeRepo(id="r3", name="没地址", local_dir="nourl")
    r4 = workdirs.plan(root, nourl, "t")
    chk("工程没配 git 地址 → 说人话，不瞎 clone",
        not r4["ok"] and "没配 git 地址" in r4["detail"], r4)

    # Prefer the user-configured root for automatic dispatch; fall back only if unresolved.
    c1 = FakeClient(work_root=root)
    d1, why1 = workdirs.auto_dir(c1, repo)
    chk("★自动派活也用这台 SoduWork 设的工作目录（这才叫「一律」）",
        os.path.normcase(d1) == os.path.normcase(want), (d1, why1))
    c2 = FakeClient(work_root="")
    fallback = FakeRepo(git_url=origin, ai_work_dir=r"C:\old\ai-work")
    d2b, why2 = workdirs.auto_dir(c2, fallback)
    chk("★没报过工作目录 → 回落工程的 ai_work_dir（别让自动派活比今天更差）",
        d2b == r"C:\old\ai-work", (d2b, why2))
    d3, why3 = workdirs.auto_dir(c2, FakeRepo(git_url=origin))
    chk("两个都没有 → 明说没有可用目录", d3 == "" and "没有" in why3, (d3, why3))

    # Detect corrupted Office output files.
    good = os.path.join(base, "good.docx")
    with open(good, "wb") as f:
        f.write(b"PK\x03\x04rest-of-a-zip")
    bad = os.path.join(base, "bad.docx")
    with open(bad, "wb") as f:
        f.write(b"\x00\x01not-a-zip-at-all")
    txt = os.path.join(base, "note.txt")
    io.open(txt, "w", encoding="utf-8").write("随便")
    chk("★正常的 docx 不误报", workdirs.check_artifact(good) == "", workdirs.check_artifact(good))
    chk("★★被弄坏的 docx 认得出来（那次事故就是它悄悄坏掉的）",
        "不是有效" in workdirs.check_artifact(bad), workdirs.check_artifact(bad))
    chk("非 Office 文件不管", workdirs.check_artifact(txt) == "")
    chk("文件不存在时不炸", isinstance(workdirs.check_artifact(
        os.path.join(base, "没有这个.docx")), str))

    # Verify path safety.
    evil = FakeRepo(id="r9", name="坏", local_dir="../../跑出去")
    ed = workdirs.repo_dir(root, evil)
    chk("★工程子目录不许跳出工作目录（../..）",
        os.path.normcase(root) in os.path.normcase(ed), ed)
finally:
    rm_tree(base)
    rm_tree(SMOKE_DATA)

log.append("")
log.append("PASS=%d FAIL=%d" % (ok, fail))
with io.open("smoke_workdirs.out.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(log))
print("PASS=%d FAIL=%d" % (ok, fail))
sys.exit(1 if fail else 0)
