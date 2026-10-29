"""Synthetic connector for verifying pull-to-ingest behavior without contacting an external
platform.
"""
import json


class ExampleConnector:
    type = "example"

    def pull(self, config: dict, cursor: dict) -> tuple[list[dict], dict]:
        n = int((cursor or {}).get("n", 0))
        items = [
            {
                "external_id": f"ex-{n + 1}",
                "title": f"示例任务 {n + 1}",
                "status": "todo",
                "assignee": (config or {}).get("assignee", "demo-user"),
                "source_label": f"示例源 #{n + 1}",
            }
        ]
        return items, {"n": n + 1}

    def parse_webhook(self, headers: dict, body: bytes) -> list[dict]:
        try:
            data = json.loads(body or b"{}")
        except Exception:
            return []
        if isinstance(data, dict) and isinstance(data.get("items"), list):
            return data["items"]
        if isinstance(data, dict) and data.get("external_id"):
            return [data]
        return []
