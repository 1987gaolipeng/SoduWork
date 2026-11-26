"""Short descriptions for automatically issued requirement and delivery gates."""
import re

from .session_memory import clean
from .task_requirements import public_content


def summary_text(value):
    if not isinstance(value, str):
        return ""
    # A download path, query or fragment may itself be a credential. Keep the
    # surrounding prose, without promoting the link into the inbox preview.
    # Only inspect a prefix for the 240-character preview. Never return a
    # partial key block if the other delimiter lies outside that prefix.
    value = value[:4096].partition("-----BEGIN ")[0]
    value = re.sub(r"""(?i)(?:[a-z][a-z\d+.-]{0,31}://|www\.)[^\s<>"']+""", "[链接]", value)
    value = re.sub(r"""(?i)\btoken["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)""", "token=[凭据已隐藏]", value)
    value = re.sub(r"[\x00-\x1f\x7f]", " ", clean(value))
    return " ".join(value.split())[:240]


def for_artifact(task, artifact):
    manifest = artifact.manifest if isinstance(artifact.manifest, dict) else {}
    if artifact.kind == "code":
        commits = manifest.get("commits")
        if isinstance(commits, list) and commits and isinstance(commits[0], dict):
            subject = summary_text(commits[0].get("subject"))
            if subject:
                return subject
    if artifact.kind == "requirement":
        criteria = manifest.get("acceptanceCriteria")
        if isinstance(criteria, list) and criteria:
            first = criteria[0]
            if isinstance(first, dict):
                first = first.get("label") or first.get("name")
            criterion = summary_text(first)
            if criterion:
                return criterion
    text = summary_text(manifest.get("text"))
    if not text and not manifest.get("manual"):
        text = summary_text(manifest.get("summary"))
    if text:
        return text
    primary = manifest.get("primary") or manifest.get("files")
    if isinstance(primary, list):
        for entry in primary:
            if isinstance(entry, dict) and entry.get("role", "output") == "output":
                name = summary_text(entry.get("name"))
                if name:
                    return ("交付文件：" + name)[:240]
    public = public_content(task)
    description = summary_text(public.get("note") or public.get("title"))
    kind = {"requirement": "需求基线", "code": "代码交付", "manual": "手动验收",
            "url": "链接交付"}.get(artifact.kind, "交付")
    return f"{kind} v{artifact.seq} · {description}"[:240].rstrip(" ·")


def auto_context(context, artifact):
    """Recognize the producer's version-bound context, excluding workflow gates."""
    return (isinstance(context, dict) and not context.get("workflowRunId") and not context.get("nodeRunId")
            and context.get("version") == artifact.seq and context.get("checksum") == artifact.checksum)


def pending_context(request, task, artifact):
    context = request.context or {}
    if (request.status == "pending" and request.action in ("review", "baseline")
            and auto_context(context, artifact)
            and context.get("summary") in ("产出待审阅", "代码待审阅", "需求基线待确认")):
        return {**context, "summary": for_artifact(task, artifact)}
    return context
