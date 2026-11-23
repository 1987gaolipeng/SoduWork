"""Source classification is explicit. Keep unknown historical records discoverable."""
from fastapi import HTTPException
from sqlalchemy import and_


def creation_source(actor, requested=None, parent=None):
    if requested not in (None, "", "business", "test"):
        raise HTTPException(422, "数据来源无效")
    if getattr(actor, "is_test_account", False) or getattr(parent, "data_source", None) == "test":
        return "test"
    return requested or "business"


def record_fields(row):
    return {"dataSource": row.data_source, "isArchived": row.is_archived}


def business_visible(model):
    return and_(model.is_archived.is_(False), model.data_source != "test")
