"""Small immutable package fixtures shared by plugin smoke scenarios."""
import io
import json
import zipfile


def package(manifest, workflow=None, extra=None, stamp=None):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        def put(name, data):
            if stamp:
                info = zipfile.ZipInfo(name, date_time=stamp)
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, data)
            else:
                z.writestr(name, data)

        put("plugin.json", json.dumps(manifest, ensure_ascii=False))
        if workflow is not None:
            put("workflow.json", json.dumps(workflow, ensure_ascii=False))
        for name, data in (extra or {}).items():
            put(name, data)
    return buf.getvalue()


def external_package(kind, manifest, extra=None, root=""):
    buf = io.BytesIO()
    root = root.rstrip("/") + ("/" if root else "")
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(root + f".{kind}-plugin/plugin.json",
                   json.dumps(manifest, ensure_ascii=False))
        for name, data in (extra or {}).items():
            z.writestr(root + name, data)
    return buf.getvalue()


BASE = {
    "schemaVersion": 1,
    "key": "smoke-delivery",
    "name": "交付门冒烟",
    "version": "1.0.0",
    "description": "验证插件安全门",
    "inputs": [{"key": "ready", "type": "boolean"}],
}
FLOW = {
    "nodes": [
        {"key": "check", "type": "condition", "config": {"inputKey": "ready", "equals": True}},
        {"key": "review", "type": "human_review", "dependsOn": ["check"],
         "config": {"summary": "请审阅插件产出"}},
        {"key": "publish", "type": "publish", "dependsOn": ["review"],
         "config": {"message": "插件交付完成"}},
    ]
}
