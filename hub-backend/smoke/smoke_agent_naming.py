# -*- coding: utf-8 -*-
"""Regression checks for agent names and Runner identity."""
import os
import sys

DB = os.path.abspath(".smoke-naming.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app.services import agent_naming  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra) if extra else ""))


def main():
    # Verify single-label precedence from alias through owner, host, ID, and fallback.
    chk("★单台个人执行机默认使用账号姓名", agent_naming.machine_label(
        person="张三", host="DESKTOP-FIXTURE", runner_id="abcdef012345") == "张三的电脑")
    chk("★人起的名字优先", agent_naming.machine_label(
        alias="打包机", person="张三", host="DESKTOP-FIXTURE") == "打包机")
    chk("没起名就报主机名", agent_naming.machine_label(
        host="DESKTOP-FIXTURE", runner_id="abcdef012345") == "DESKTOP-FIXTURE")
    chk("★连主机名都没有才退 id，且不摆一长串", agent_naming.machine_label(
        runner_id="abcdef012345abcdef") == "abcdef012345")
    chk("什么都没有才兜底", agent_naming.machine_label(fallback="服务端") == "服务端")
    chk("全空也不给空字符串", agent_naming.machine_label() == "未知执行机")
    chk("空白字符不算数", agent_naming.machine_label(person="  ", host="h") == "h")

    # Add OS context to opaque container-like hostnames.
    chk("★容器 id 补系统标记", agent_naming.auto_machine_label(
        host="012345abcdef", os_name="Linux-4.19.91-26.an8.x86_64") == "012345abcdef(Linux)")
    chk("正常主机名不加料", agent_naming.auto_machine_label(
        host="DESKTOP-FIXTURE", os_name="Windows-10-10.0.19045-SP0") == "DESKTOP-FIXTURE")
    chk("认不出系统就不硬加", agent_naming.auto_machine_label(host="012345abcdef") == "012345abcdef")
    chk("系统串压成一个词", (agent_naming.os_tag("Windows-10-10.0.19045-SP0"),
                             agent_naming.os_tag("Linux-4.19.91-26.an8"),
                             agent_naming.os_tag("Darwin-23"),
                             agent_naming.os_tag("")) == ("Windows", "Linux", "macOS", ""))

    # Ensure automatically generated machine labels are unique.
    labels = agent_naming.unique_machine_labels([
        {"key": "a", "host": "DESKTOP-FIXTURE", "osName": "Windows-10", "runnerId": "fedcba987654"},
        {"key": "b", "host": "012345abcdef", "osName": "Linux-4.19", "runnerId": "runner-trial-dev"},
    ])
    chk("★真机那两台机器不再重名", labels["a"] != labels["b"], labels)
    chk("★两台都认得出是哪台", labels == {"a": "DESKTOP-FIXTURE", "b": "012345abcdef(Linux)"}, labels)
    same = agent_naming.unique_machine_labels([
        {"key": "a", "host": "BUILD", "osName": "Windows-10", "runnerId": "aaaaaa111111"},
        {"key": "b", "host": "BUILD", "osName": "Linux-4.19", "runnerId": "bbbbbb222222"},
    ])
    chk("★主机名真撞了就靠系统标记分开", same["a"] != same["b"], same)
    twins = agent_naming.unique_machine_labels([
        {"key": "a", "host": "BUILD", "osName": "Linux-4.19", "runnerId": "aaaaaa111111"},
        {"key": "b", "host": "BUILD", "osName": "Linux-5.10", "runnerId": "bbbbbb222222"},
    ])
    chk("★系统也一样就补 id 短码，绝不放两个同名的出去", twins["a"] != twins["b"], twins)
    keep = agent_naming.unique_machine_labels([
        {"key": "a", "alias": "我的开发机", "host": "DESKTOP-FIXTURE"},
        {"key": "b", "host": "012345abcdef", "osName": "Linux"},
    ])
    chk("★起过名的原样用，不替人加料", keep["a"] == "我的开发机", keep)
    owned = agent_naming.unique_machine_labels([
        {"key": "win", "person": "张三", "host": "DESKTOP-FIXTURE",
         "osName": "Windows-10", "runnerId": "fedcba987654"},
        {"key": "build", "person": "张三", "host": "BUILD-01",
         "osName": "Linux", "runnerId": "runner-build"},
    ])
    chk("★同一账号有多台电脑时自动补主机名", owned == {
        "win": "张三 · DESKTOP-FIXTURE", "build": "张三 · BUILD-01"}, owned)


    # Use the same machine/runtime seat-label format for all providers.
    chk("★远程席位默认显示归属人", agent_naming.display_name(
        "Pi", person="张三", host="DESKTOP-FIXTURE") == "张三的电脑 · Pi")
    chk("给了机器名就直接用", agent_naming.display_name("Pi", "测试服 trial") == "测试服 trial · Pi")
    chk("本机席位也报主机名（不再叫「本机」）", agent_naming.display_name(
        "Pi", host="DESKTOP-FIXTURE", fallback="服务端") == "DESKTOP-FIXTURE · Pi")
    chk("后端连主机名都没有时才叫服务端", agent_naming.display_name(
        "Pi", fallback="服务端") == "服务端 · Pi")
    chk("CLI 名缺失也不崩", agent_naming.display_name("", host="h") == "h · AI")
    chk("托管的没有「哪台」可言", agent_naming.hosted_name() == "托管智能体")

    # Group by machine and runtime rather than display name or transport.
    a = agent_naming.desk_key(host="", cli="pi")
    b = agent_naming.desk_key(runner_id="rn-a", cli="pi")
    c = agent_naming.desk_key(runner_id="rn-b", cli="pi")
    chk("★两台不同 runner 上的 Pi 各算各的", b != c, (b, c))
    chk("★说不出机器的历史记录不和具体机器混", a != b, (a, b))
    chk("同一台机器上的同一个底座才合并", b == agent_naming.desk_key(runner_id="rn-a", cli="pi"))
    chk("同一台机器上的不同底座分开", b != agent_naming.desk_key(runner_id="rn-a", cli="opencode"))
    chk("★改了显示名不会把历史裂成两张卡",
        agent_naming.desk_key(runner_id="rn-a", cli="pi", name="老名字") ==
        agent_naming.desk_key(runner_id="rn-a", cli="pi", name="新名字"))
    chk("什么都没有时退回用名字，别塌成同一个键",
        agent_naming.desk_key(name="托管智能体") != agent_naming.desk_key(name="别的"))

    # Merge local and embedded-Runner seats on the same machine.
    chk("★★同一台机器的两条执行路合成一张卡",
        agent_naming.desk_key(host="DESKTOP-FIXTURE", cli="pi") ==
        agent_naming.desk_key(host="DESKTOP-FIXTURE", runner_id="fedcba987654", cli="pi"),
        (agent_naming.desk_key(host="DESKTOP-FIXTURE", cli="pi"),
         agent_naming.desk_key(host="DESKTOP-FIXTURE", runner_id="fedcba987654", cli="pi")))
    chk("★主机名大小写不该劈成两张卡",
        agent_naming.desk_key(host="DESKTOP-FIXTURE", cli="pi") ==
        agent_naming.desk_key(host="desktop-fixture", cli="pi"))

    # Normalize historical display names and current runtime keys to the same seat.
    chk("★历史活的 OpenCode 和名单里的 opencode 是同一张卡",
        agent_naming.desk_key(host="h", cli="OpenCode") ==
        agent_naming.desk_key(host="h", cli="opencode"))
    chk("★Claude Code 与 claude 也归一",
        agent_naming.desk_key(host="h", cli="Claude Code") ==
        agent_naming.desk_key(host="h", cli="claude"))
    chk("Pi 与 pi 归一",
        agent_naming.desk_key(host="h", cli="Pi") == agent_naming.desk_key(host="h", cli="pi"))
    chk("不同底座仍旧分开",
        agent_naming.desk_key(host="h", cli="Pi") != agent_naming.desk_key(host="h", cli="opencode"))

    # Infer missing historical assigneeCli from the display name.
    # Avoid duplicate seats with empty runtime identity.
    chk("★底座为空时从显示名末段回填", agent_naming.cli_from_name("DESKTOP-FIXTURE · Pi") == "pi")
    chk("回填认得出 Claude Code", agent_naming.cli_from_name("h · Claude Code") == "claude")
    chk("回填不认识的就老实说不知道", agent_naming.cli_from_name("阿码") == "")
    chk("★★空底座的历史卡并进同一台机器的那张",
        agent_naming.desk_key(host="DESKTOP-FIXTURE", cli="", name="DESKTOP-FIXTURE · Pi") ==
        agent_naming.desk_key(host="DESKTOP-FIXTURE", cli="pi"))

    # Resolve all supported historical machine-identity forms.
    here = "DESKTOP-FIXTURE"
    chk("★老的本机派活（没记 host）归到后端那台",
        agent_naming.machine_key_for(provider="local", local_host=here) ==
        agent_naming.machine_key(host=here))
    chk("★退役的托管底座不冒充本机", agent_naming.machine_key_for(
        provider="multica", local_host=here) == "hosted:multica")
    chk("记了 host 的按 host 认", agent_naming.machine_key_for(
        provider="runner", host="012345abcdef", runner_id="runner-trial-dev", local_host=here) ==
        agent_naming.machine_key(host="012345abcdef"))
    chk("后端连主机名都没有时不硬编",
        agent_naming.machine_key_for(provider="local", local_host="") == agent_naming.LOCAL)

    # Compare readable labels for the representative real-machine cases.
    before = "本机 Pi"
    after = agent_naming.display_name("Pi", host="DESKTOP-FIXTURE", fallback="服务端")
    chk("★真机那条从「本机 Pi」变成认得出机器的名字",
        before != after and "DESKTOP-FIXTURE" in after, after)
    两台 = agent_naming.unique_machine_labels([
        {"key": "win", "host": "DESKTOP-FIXTURE", "osName": "Windows-10", "runnerId": "fedcba987654"},
        {"key": "lin", "host": "012345abcdef", "osName": "Linux-4.19", "runnerId": "runner-trial-dev"},
    ])
    名字 = [agent_naming.display_name("Pi", 两台["win"]), agent_naming.display_name("Pi", 两台["lin"])]
    chk("★★真机复现：两台执行机不再都叫「张三 · Pi」",
        名字[0] != 名字[1] and "张三" not in "".join(名字), 名字)

    print("\nagent naming smoke: %d passed, %d failed" % (ok, fail))
    return 1 if fail else 0


sys.exit(main())
