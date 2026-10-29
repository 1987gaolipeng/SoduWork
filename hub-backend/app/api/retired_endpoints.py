"""Explicit upgrade response for removed client features; no legacy writes."""
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/v1", include_in_schema=False)


@router.api_route("/work-items", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
@router.api_route("/work-items/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def retired_requirement_pool(path: str = ""):
    raise HTTPException(410, "需求池已升级为统一需求，请升级 SoduWork 客户端后继续。原有需求和附件已保留。")
