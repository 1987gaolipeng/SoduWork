"""Opt-in limit/offset pagination. Omitted parameters retain legacy list responses."""
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Query
from sqlalchemy import func, select


@dataclass(frozen=True)
class Page:
    limit: int
    offset: int

    def window(self, query):
        return query.offset(self.offset).limit(self.limit)

    async def total(self, session, query):
        return await session.scalar(select(func.count()).select_from(query.order_by(None).subquery()))


def optional_page(limit: Annotated[int | None, Query(ge=1, le=200)] = None,
                  offset: Annotated[int | None, Query(ge=0, le=2**63-1)] = None) -> Page | None:
    if limit is None and offset is None:
        return None
    return Page(limit or 50, offset or 0)


PageQuery = Annotated[Page | None, Depends(optional_page)]


async def select_rows(session, query, page=None):
    total = await page.total(session, query) if page else None
    rows = (await session.scalars(page.window(query) if page else query)).all()
    return rows, total


def list_result(items, total):
    return items if total is None else {"items": items, "total": total}
