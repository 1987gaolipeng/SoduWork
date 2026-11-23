"""Atomic conditional writes for the automation template catalog."""
import hashlib

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from ..models import AppSetting


class CatalogConflict(ValueError):
    pass


def revision(value):
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()


async def read(session, key):
    return (await session.execute(select(AppSetting.value).where(AppSetting.key == key))).scalar_one_or_none()


async def replace(session, key, previous, value):
    if previous is None:
        try:
            async with session.begin_nested():
                session.add(AppSetting(key=key, value=value))
                await session.flush()
        except IntegrityError as exc:
            raise CatalogConflict("Template catalog changed. Reload and review your draft before saving.") from exc
    else:
        result = await session.execute(update(AppSetting).where(
            AppSetting.key == key, AppSetting.value == previous
        ).values(value=value).execution_options(synchronize_session=False))
        if result.rowcount != 1:
            raise CatalogConflict("Template catalog changed. Reload and review your draft before saving.")
