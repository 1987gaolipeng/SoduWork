"""Runner follow-up admission, attachments and explicit executor selection."""
import asyncio
import os
import uuid

from . import ai_local, runner_admission


async def comment(machine, m, read_local_files):
    from app.services import local_stream
    ref = str(m.get("ref") or "")
    if not ref:
        return {"ok": False, "error": "会话标识不能为空"}
    from app.services import dispatch_identity
    turn_id = dispatch_identity.clean_dispatch_id(m.get("turnId"))
    if not turn_id:
        turn_id = "turn:" + uuid.uuid4().hex
        m = dict(m)
        m["turnId"] = turn_id
    selected = None
    if m.get("executionSelection") is not None:
        from . import execution_selection, runner_turn_selection
        try:
            raw = execution_selection.normalize(m["executionSelection"])
            previous = machine._admission.get("comment:" + turn_id)
            if previous and not m.get("_admitted"):
                original = (previous.payload or {}).get("executionSelection")
                if raw != original or str((previous.payload or {}).get("text") or "") != str(m.get("text") or ""):
                    raise execution_selection.SelectionError("消息编号已用于其他内容或执行选择")
                return {"ok": True, "data": {**machine._admission.receipt(previous, duplicate=True),
                    "acceptedSelection": (previous.payload or {}).get("_acceptedSelection") or raw,
                    "acceptedSelectionRevision": previous.sequence}}
            selected = await asyncio.to_thread(runner_turn_selection.validate, ref, raw, m.get("cfg"))
            from . import local_base
            with local_base._LOCK:
                switching = selected != execution_selection.current(local_base._RUNS.get(ref) or {})
            machine._reap_admission()
            if switching and not m.get("_admitted") and machine._admission.latest_for_ref(ref):
                raise execution_selection.SelectionError("请等待当前轮次及排队消息完成后再切换", "EXECUTION_SWITCH_BUSY")
            m = {**m, "executionSelection": raw, "_acceptedSelection": selected}
        except (execution_selection.SelectionError, ValueError) as exc:
            return {"ok": False, "code": getattr(exc, "code", "EXECUTION_SELECTION_INVALID"), "error": str(exc)}
    if not m.get("_admitted"):
        result = await machine._admit(m, key="comment:" + turn_id, ref=ref,
            category=runner_admission.INTERACTIVE, operation="comment")
        if selected and result.get("ok"):
            item = machine._admission.get("comment:" + turn_id)
            result["data"] = {**result.get("data", {}), "acceptedSelection": selected,
                              "acceptedSelectionRevision": item.sequence}
        return result
    user_text = str(m.get("text") or "")
    text = str(m.get("promptText") or user_text)
    staged = []
    if m.get("_localParent") and m.get("localFiles"):
        files = read_local_files(m.get("localFiles") or [], "\u8865\u5145\u9644\u4ef6")
        inputs = [(str(meta.get("filename") or "\u9644\u4ef6"), data,
                   str(meta.get("contentType") or "application/octet-stream"))
                  for meta, data in files]
        staged = await asyncio.to_thread(ai_local._stage_inputs, ref, inputs)
        if staged:
            text += "\n\n\u3010\u672c\u8f6e\u8865\u5145\u6587\u4ef6\u3011\n" + "\n".join(
                "- %s\uff1a%s" % (item.get("name") or "\u9644\u4ef6", item.get("path") or "")
                for item in staged)
    if m.get("recordUser"):
        await asyncio.to_thread(local_stream.record_user_sync, ref, user_text, staged,
                                m.get("plugins"), m.get("sentAt"))
    from app.services import runtime_images
    try:
        cfg = {**dict(m.get("cfg") or {}), "_admissionKey": str(m.get("_admissionKey") or "")}
        if selected is not None:
            cfg["_executionSelection"] = selected
        turn_cfg = await asyncio.to_thread(runtime_images.prepare, cfg,
            staged, os.path.join(ai_local._store_dir(ref), "inputs"))
    except (runtime_images.ImageInputError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    result = await asyncio.to_thread(
        local_stream.comment_sync, turn_cfg, ref, text)
    return {"ok": bool(result.get("ok")), "data": result,
            "error": str(result.get("error") or "")}
