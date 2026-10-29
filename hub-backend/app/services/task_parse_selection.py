"""Keep model recommendations separate from selections in the direct instruction."""
from __future__ import annotations

import re

from .automation_draft import _directive_text

_HYPOTHETICAL = r"如果|假如|例如|比如|是否|能否|能不能|\b(?:if|whether|example)\b"
_TEXT_EDIT = r"(?:标题|名称|备注|正文|描述).{0,10}(?:改为|改成|设为|写成|叫做|叫|增加|添加)"
_NEGATIVE = r"(?:不要|不用|不必|无需|别|不想|不再|禁止|避免|不能|不是|不建议|do not|don't|never)[^，,。；;\n]*$|不\s*$"
_FLOW_WORD = r"(?:工作流|流程|插件)"
_USE = r"(?:使用|选用|选择|采用|启用|通过|按照|按|用|\buse|\busing)"
_OPEN = r"[【「『《“\"']*"
_CLOSE = r"[】」』》”\"']*"


def _clauses(instruction):
    # Described document edits are content, even when they contain routing verbs.
    text = _directive_text(str(instruction or "").replace("‘", "“").replace("’", "”"))
    text = re.sub(r"```[\s\S]*?(?:```|$)|(?m:^\s*>[^\n]*)", " ", text)
    # A quoted name after a routing verb is a target; a quoted sentence is data.
    pairs = {'“': '”', '「': '」', '『': '』', '《': '》', '"': '"', "'": "'"}
    chars, index = list(text), 0
    while index < len(text):
        close = pairs.get(text[index])
        if close:
            end = text.find(close, index + 1)
            if end >= 0:
                prefix = re.split(r"[，,。；;\n]", text[:index])[-1]
                if not re.search(r"(?:转交给|转给|交办给|交给|指派给|分配给|派给|安排给|让|由|请|" + _USE + r")\s*(?:名为\s*)?(?:" + _FLOW_WORD + r"\s*[:：]?\s*)?$", prefix, re.I):
                    chars[index:end + 1] = " " * (end - index + 1)
                index = end
        index += 1
    text = "".join(chars)
    return [part.strip() for part in re.split(r"[，,。；;\n]", text)
            if part.strip() and not re.search(_HYPOTHETICAL + "|" + _TEXT_EDIT, part, re.I)]


def _person(clauses, suggested=""):
    targets = []
    stop = r"(?=\s|[，,。；;：:！!？?]|负责|处理|修复|完成|执行|来做|来处理|做|跟进|接手|$)"
    pattern = re.compile(r"(?:转交给|转给|交办给|交给|指派给|分配给|派给|安排给)\s*" +
                         _OPEN + r"([^\s，,。；;：:！!？?【】「」『』《》“”\"']{1,30}?)" + _CLOSE + stop)
    for clause in clauses:
        if re.search(r"(?:我自己|我来|由我)(?:做|处理|负责|修复|完成|执行|跟进)?", clause) and not re.search(_NEGATIVE, clause.split("我", 1)[0]):
            targets.append("me")
        matches = list(pattern.finditer(clause))
        if not matches:
            # UI-display, server-provided, and urgent-repair phrasing can also address an action target.
            # objects or actions. Weak syntax corroborates a parsed name, never invents one.
            name = _OPEN + r"([^\s，,。；;：:！!？?【】「」『』《》“”\"']{1,20}?)" + _CLOSE
            matches = list(re.finditer(r"(?:让|由(?!于))\s*" + name + stop, clause))
            if not matches:
                matches = list(re.finditer(r"请\s*" + name + r"\s*(?=负责|处理|修复|完成|执行|跟进|开发|测试)", clause))
            if not matches:
                matches = list(re.finditer(r"^\s*" + name + r"\s*负责(?:处理|修复|完成|执行|跟进|开发|测试)", clause))
            matches = [match for match in matches if suggested and _normal(match.group(1)) == _normal(suggested)]
        for match in matches:
            if re.search(_NEGATIVE, clause[:match.start()], re.I):
                continue
            target = match.group(1)
            if target.lower() in {"ai", "人工智能"}:
                target = "ai"
            elif target in {"我", "我自己", "自己"}:
                target = "me"
            targets.append(target)
    return list(dict.fromkeys(targets))


def _normal(value):
    return re.sub(r"\s+", "", str(value or "")).casefold()


def _flow(clauses, flows):
    references = []
    cleared = False
    clear_names = []
    for clause in clauses:
        if re.search(r"(?:不(?:要|用|使用|走|需要)|无需|取消|清空|移除)\s*(?:使用|走)?\s*(?:任何|所有)?" + _FLOW_WORD + r"\s*(?:了)?$", clause):
            cleared = True
            continue
        known, recognized = [], False
        for index, row in enumerate(flows):
            for alias in dict.fromkeys(str(row.get(field) or "") for field in ("displayName", "name", "key")):
                if not alias:
                    continue
                name_pattern = r"\s*".join(re.escape(part) for part in re.split(r"\s+", alias))
                for match in re.finditer(name_pattern, clause, re.I):
                    prefix = clause[:match.start()]
                    action = re.search(_USE + r"\s*(?:名为\s*)?(?:" + _FLOW_WORD + r"\s*[:：]?\s*)?" + _OPEN + r"\s*$", prefix, re.I)
                    suffix = clause[match.end():]
                    if not action:
                        continue
                    if suffix and not re.match(_CLOSE + r"(?:\s|流程|工作流|插件|执行|运行|处理|修复|[，,。；;]|$)", suffix):
                        continue
                    recognized = True
                    reference = str(row.get("name") or alias) if alias == row.get("displayName") else match.group(0)
                    if re.search(_NEGATIVE, prefix[:action.start()], re.I):
                        cleared = True
                        clear_names.append(reference)
                        continue
                    known.append((index, reference))
        if known:
            references.append((known[0][1], {index for index, _ in known}))
            continue
        if recognized:
            continue
        # Preserve unknown explicit references so the form can request confirmation.
        patterns = [
            _USE + r"\s*" + _OPEN + r"(.+?)" + _CLOSE + r"\s*" + _FLOW_WORD,
            _USE + r"\s*" + _FLOW_WORD + r"\s*[:：]?\s*" + _OPEN + r"([^\s，,。；;]+?)" + _CLOSE + r"(?=\s|执行|运行|$)",
        ]
        for pattern in patterns:
            match = re.search(pattern, clause, re.I)
            if match:
                name = match.group(1).strip(" 【】「」『』《》“”\"'")
                if name:
                    if re.search(_NEGATIVE, clause[:match.start()], re.I):
                        cleared = True
                        clear_names.append(name)
                        break
                    matches = {i for i, row in enumerate(flows) if _normal(name) in {_normal(row.get("key")), _normal(row.get("name"))}}
                    references.append((name, matches))
                    break
    if not references:
        names = list(dict.fromkeys(clear_names))
        return {"flow": "", "flowExplicit": cleared,
                "flowReferences": names,
                **({"flowCleared": True, "flowRequested": "、".join(names)} if cleared else {})}
    names = list(dict.fromkeys(name for name, _ in references))
    choices = set().union(*(matches for _, matches in references))
    if len(names) > 1 or len(choices) > 1 or cleared:
        return {"flow": "", "flowExplicit": False, "flowRequested": "、".join(names), "flowReferences": names, "flowProblem": "ambiguous"}
    if not choices:
        return {"flow": "", "flowExplicit": False, "flowRequested": names[0], "flowReferences": names, "flowProblem": "unavailable"}
    row = flows[next(iter(choices))]
    return {"flow": row["key"], "flowExplicit": True, "flowRequested": names[0], "flowReferences": names, "flowProblem": ""}


def apply(got: dict, instruction: str, flows: list[dict]) -> dict:
    out = dict(got)
    for key in ("flowCleared", "flowProblem", "flowRequested", "flowReferences", "assigneeProblem", "assigneeRequested", "assigneeReferences"):
        out.pop(key, None)
    proposed = str(out.pop("flow", "") or "")
    if proposed and any(row.get("key") == proposed for row in flows):
        out["recommendedFlow"] = proposed
        out["recommendedFlowSource"] = "model"
    clauses = _clauses(instruction)
    targets = _person(clauses, out.get("assignee"))
    out["assigneeExplicit"] = bool(targets)
    out["assigneeSource"] = "instruction" if targets else "model" if out.get("assignee") else ""
    if len(targets) > 1:
        out.update(assignee="", assigneeProblem="ambiguous", assigneeRequested="、".join(targets), assigneeReferences=targets)
    elif targets:
        out["assignee"] = targets[0]
    elif str(out.get("assignee") or "").lower() in {"workflow", "flow", "plugin"}:
        out.pop("assignee", None)
        out["assigneeSource"] = ""
    out.update(_flow(clauses, flows))
    return out
