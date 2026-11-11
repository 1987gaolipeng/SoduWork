# -*- coding: utf-8 -*-
"""Pure-function development-flow tests for defaults, invariant safety rules, branch templates,
evidence modes, unattended behavior, inheritance, editable steps, merge requests, commit
conventions, environment-specific commands, presets, and malformed configuration.
"""
import io
import sys

sys.path.insert(0, ".")
from app.services import ai_flow_presets as PS  # noqa: E402
from app.services import ai_prompts as P  # noqa: E402

ok = fail = 0
log = []

WIN = {"os": "windows", "shell": "powershell"}
NIX = {"os": "linux", "shell": "bash"}


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        log.append("  PASS  " + name)
    else:
        fail += 1
        log.append("  FAIL  " + name + ("  << " + str(extra)[:400] if extra else ""))


# Default configuration uses the built-in steps.
d = P.dev_flow("develop", local=True, task_id="tms123", env=WIN)
chk("默认：六步全在", all(t in d for t in ("切出工作分支", "改代码", "自测", "自证", "提交并推送", "回复要点")), d[:300])
chk("默认：分支名 fix/<任务号>", "fix/tms123" in d)
chk("默认：基线分支写进正文", "`develop`" in d)
chk("默认：切错分支的血泪口径还在", "把这一条的提交混进去" in d)
chk("默认：截图那一步在（auto）", "截图验证" in d and "界面类改动必须" in d)
chk("默认：本机的产出物口径", "SoduWork 会自己从这个目录把新文件收走" in d)
chk("默认：通用自测说法", "跑这个工程既有的测试/构建" in d)
chk("默认：带浏览器端口纪律", "随机高位端口" in d)
chk("默认：提交信息使用任务语言", "提交信息用任务描述的语言" in d)
chk("默认：不建 MR 就不提 MR 那一步", "提交合并请求" not in d)
h = P.dev_flow("main", local=False, task_id="tms123")
chk("托管：截图当评论附件交回", "评论附件" in h)

# Safety constraints remain present under every configuration.
RED = ["自己合进基线分支", "发布上线", "force push"]
CFGS = ({}, {"screenshot": "never"}, {"mr": "required"},
        {"steps": [{"title": "随便一步", "detail": "干点啥"}]},
        {"branch": "feat/{task}", "selftest": "make test", "commit": "按 Conventional Commits"})
for cfg in CFGS:
    t = P.dev_flow("develop", local=True, task_id="tmsX", cfg=cfg, env=NIX)
    for r in RED:
        chk("红线常在（%s）：%s" % (list(cfg) or "空配置", r), r in t)

# Validate branch templates.
chk("自定义模板生效", P.work_branch("tms9", {"branch": "feature/{task}-ai"}) == "feature/tms9-ai")
chk("模板没有 {task} → 退回默认", P.work_branch("tms9", {"branch": "mybranch"}) == "fix/tms9")
chk("check 拦住没有 {task} 的模板", "任务号" in P.check({"branch": "mybranch"}))
chk("check 拦住非法字符", P.check({"branch": "fix/{task} x"}) != "")
chk("check 放行正常模板", P.check({"branch": "feature/{task}"}) == "")
chk("任务号里的怪字符被洗掉", P.work_branch("t m/s;1") == "fix/tms1")

# Render verification commands and commit conventions.
t = P.dev_flow("develop", True, "tms1", cfg={"selftest": "npm run build"}, env=WIN)
chk("自测命令写死进正文", "`npm run build`" in t)
chk("配了命令就不再说通用说法", "跑这个工程既有的测试/构建" not in t)
t = P.dev_flow("develop", True, "tms1", cfg={"commit": "首行必须是 [{task}] 开头"}, env=WIN)
chk("提交信息规范生效且任务号被替换", "[tms1] 开头" in t, t[t.find("提交并推送"):][:200])
chk("配了规范就不再说默认那句", "提交信息用任务描述的语言" not in t)

# Verify all evidence modes.
never = P.dev_flow("develop", True, "tms1", cfg={"screenshot": "never"}, env=WIN)
chk("never：明说不许拉 GUI 浏览器", "不要启动 GUI 浏览器截图" in never)
chk("never：给了替代自证（产物核对）", "构建产物" in never)
chk("never：浏览器端口纪律成了噪音 → 撤掉", "随机高位端口" not in never)
always = P.dev_flow("develop", True, "tms1", cfg={"screenshot": "always"}, env=WIN)
chk("always：纯后端也要留证据", "纯后端改动也要留" in always)
u = P.dev_flow("develop", True, "tms1", cfg={"screenshot": "always"}, unattended=True, env=WIN)
chk("unattended 压过工程配的 always", "不要启动 GUI 浏览器截图" in u and "纯后端改动也要留" not in u)

# Verify merge-request configuration.
mr = P.dev_flow("develop", True, "tms1", cfg={"mr": "create", "mrTarget": "release"}, env=NIX)
chk("create：多出「提交合并请求」这一步", "提交合并请求" in mr)
chk("create：目标分支用配的那个", "向 `release`" in mr, mr[mr.find("合并请求"):][:160])
chk("create：MR 步插在提交之后、回复之前",
    mr.find("提交并推送") < mr.find("提交合并请求") < mr.find("回复要点"))
chk("create：仍然明说不许自己合", "自己合进基线分支" in mr)
req = P.dev_flow("develop", True, "tms1", cfg={"mr": "required"}, env=NIX)
chk("required：明说没 MR 不算交完", "没有 MR 这活不算交完" in req)
chk("MR 目标没配就用基线分支", "向 `develop`" in req)
chk("check 拦住乱填的 mr", P.check({"mr": "maybe"}) != "")

# Add, remove, edit, and reorder steps.
steps = [{"key": "a", "title": "先建 MR 占位", "detail": "从 `{base}` 切 `{work}` 后先开一个 Draft MR。"},
         {"key": "b", "title": "再改代码", "detail": "小步提交。"}]
s = P.dev_flow("develop", True, "tms1", cfg={"steps": steps}, env=NIX)
chk("自定义步骤：按顺序编号", "1. **先建 MR 占位**" in s and "2. **再改代码**" in s, s[:300])
chk("自定义步骤：内置六步不再出现", "回复要点" not in s)
chk("自定义步骤：变量被替换", "`fix/tms1`" in s and "`develop`" in s)
chk("步骤没标题的被丢掉", len(P.normalize({"steps": [{"title": "", "detail": "x"}, steps[0]]})["steps"]) == 1)
chk("check 要求每步都有要求", "还没写要求" in P.check({"steps": [{"title": "光有标题"}]}))
chk("check 拦住步骤过多", P.check({"steps": [{"title": "x", "detail": "y"}] * 30}) != "")
chk("空步骤列表 = 继承（不是清空）", P.normalize({"steps": []}, base=P.normalize({"steps": steps}))["steps"] != [])

# Render commands for the execution environment.
w = P.dev_flow("develop", True, "tms1", cfg={"screenshot": "never"}, env=WIN)
n = P.dev_flow("develop", True, "tms1", cfg={"screenshot": "never"}, env=NIX)
chk("Windows：后台起服务给 Start-Process", "Start-Process" in w)
chk("Linux：后台起服务给 nohup", "nohup" in n and "Start-Process" not in n)
chk("Windows：产物核对给 Select-String", "Select-String" in w)
chk("Linux：产物核对给 grep", "grep -r" in n)
chk("★PowerShell 管道那个坑只对 Windows 说", "别用可能挂住的管道" in w and "别用可能挂住的管道" not in n)
gen = P.dev_flow("develop", False, "tms1", cfg={"screenshot": "never"})   # Use generic guidance when the remote environment is unknown.
chk("探不到环境：两种写法都给", "Start-Process" in gen and "nohup" in gen)
chk("detect_env 认得出本机", P.detect_env()["os"] in ("windows", "linux", "macos"))

# Verify two-layer inheritance.
base = P.normalize({"branch": "feat/{task}", "screenshot": "never", "selftest": "make test"})
m = P.normalize({"selftest": ""}, base=base)
chk("空项继承全局", m["selftest"] == "make test" and m["branch"] == "feat/{task}")
m2 = P.normalize({"screenshot": "always"}, base=base)
chk("填了的覆盖全局", m2["screenshot"] == "always" and m2["selftest"] == "make test")
chk("extra 允许被清空", P.normalize({"extra": ""}, base=P.normalize({"extra": "旧的"}))["extra"] == "")

# Verify flow presets.
chk("预设至少 5 套", len(PS.PRESETS) >= 5)
for p in PS.PRESETS:
    chk("预设「%s」配置合法" % p["name"], P.check(p["cfg"]) == "", P.check(p["cfg"]))
    txt = P.dev_flow("develop", True, "tms1", cfg=p["cfg"], env=WIN)
    chk("预设「%s」渲染出正文且红线在" % p["name"], len(txt) > 400 and "force push" in txt)
gh = P.dev_flow("main", True, "tms1", cfg=PS.by_id("github-flow")["cfg"], env=NIX)
chk("GitHub Flow：PR 到 main + Conventional Commits", "向 `main`" in gh and "Conventional Commits" in gh)
rv = P.dev_flow("develop", True, "tms1", cfg=PS.by_id("review-strict")["cfg"], env=NIX)
chk("严格评审：多了自查清单那一步", "提交前自查" in rv and "回复要点" in rv)

# Malformed configuration must not crash dispatch composition.
BAD = ({"branch": None}, {"screenshot": 123}, {"selftest": "x" * 999},
       {"extra": "带{花括号}的文字"}, {"不认识的键": "x"}, {"steps": "不是列表"},
       {"steps": [{"title": "带 {json} 例子", "detail": '返回 {"a": 1} 这种'}]},
       {"mr": "create", "mrTarget": "bad branch name"})
for bad in BAD:
    try:
        P.dev_flow("develop", True, "tms1", cfg=bad, env=WIN)
        chk("脏配置不炸：%s" % list(bad)[0], True)
    except Exception as ex:                                     # noqa: BLE001
        chk("脏配置不炸：%s" % list(bad)[0], False, repr(ex))

log.append("")
log.append("PASS=%d FAIL=%d" % (ok, fail))
with io.open("smoke_devflow.out.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(log))
print("PASS=%d FAIL=%d" % (ok, fail))
sys.exit(1 if fail else 0)
