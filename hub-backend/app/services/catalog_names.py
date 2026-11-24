"""Serialize administrative catalog edits before checking names, including new rows."""
from sqlalchemy import func, select, text, update


class DuplicateName(ValueError):
    pass


async def lock_catalog(session, model):
    bind = session.get_bind()
    if bind.dialect.name == "postgresql":
        table = bind.dialect.identifier_preparer.format_table(model.__table__)
        await session.execute(text(f"LOCK TABLE {table} IN SHARE ROW EXCLUSIVE MODE"))
    else:
        await session.execute(update(model).where(False).values(id=model.id)
                              .execution_options(synchronize_session=False))


async def require_available(session, model, name, detail, *scope, exclude_id=None):
    await lock_catalog(session, model)
    await check_available(session, model, name, detail, *scope, exclude_id=exclude_id)


async def check_available(session, model, name, detail, *scope, exclude_id=None):
    """Check a name while the caller holds the catalog write lock."""
    query = select(model.id).where(func.lower(func.trim(model.name)) == func.lower(name), *scope)
    if exclude_id is not None:
        query = query.where(model.id != exclude_id)
    if await session.scalar(query.limit(1)) is not None:
        raise DuplicateName(detail)
