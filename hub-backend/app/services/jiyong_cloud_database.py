"""Independent PostgreSQL pool. Enabling storage never migrates the Hub DB."""
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from ..config import get_settings
from ..db import _smoke_db_guard

_engines = {}
REVISION = 'jiyong_0001'


class CloudError(ValueError):
    def __init__(self, message, code='JIYONG_CLOUD_UNAVAILABLE', status=503):
        super().__init__(message)
        self.code, self.status = code, status


def database_url():
    settings = get_settings()
    value = settings.jiyong_database_url
    if not value:
        raise CloudError('云端即用数据未配置，请管理员配置独立 PostgreSQL 数据库')
    cloud, hub = make_url(value), make_url(settings.database_url)
    if cloud.drivername != 'postgresql+asyncpg':
        raise CloudError('云端即用数据需要 postgresql+asyncpg 数据库')
    # Reject aliases with the same host/database even if credentials differ.
    if (hub.get_backend_name() == 'postgresql' and cloud.host == hub.host
            and (cloud.port or 5432) == (hub.port or 5432) and cloud.database == hub.database):
        raise CloudError('即用业务库必须与 Hub 核心数据库分离')
    _smoke_db_guard(value)
    return value


def engine():
    url = database_url()
    if url not in _engines:
        _engines[url] = create_async_engine(url, pool_size=5, max_overflow=5,
                                            pool_timeout=10, pool_pre_ping=True,
                                            connect_args={'timeout': 10, 'command_timeout': 20})
    return _engines[url]


async def check():
    try:
        async with engine().connect() as connection:
            revision = await connection.scalar(text('SELECT version_num FROM alembic_version'))
            if revision != REVISION:
                raise CloudError('即用业务库需要执行独立 Alembic 升级')
            # Readiness is read-only; no schema, seeds, files or test rows.
            await connection.execute(text('SELECT id FROM jiyong_spaces LIMIT 0'))
            permissions = await connection.scalar(text(
                "SELECT has_database_privilege(current_user,current_database(),'CREATE') "
                "AND has_table_privilege(current_user,'jiyong_spaces','SELECT,INSERT,UPDATE')"))
            if not permissions:
                raise CloudError('即用数据库账号缺少创建应用空间或登记权限')
    except CloudError:
        raise
    except Exception as exc:
        raise CloudError('云端即用数据库不可用，请检查连接和独立数据库迁移') from exc
    from pathlib import Path
    directory = get_settings().jiyong_asset_dir
    if not directory or not Path(directory).is_absolute():
        raise CloudError('请配置云端即用素材的绝对持久目录，多节点须使用共享存储')
    return {'ok': True, 'location': 'cloud', 'engine': 'postgresql', 'schemaVersion': 1}


async def close():
    engines = list(_engines.values())
    _engines.clear()
    for value in engines:
        await value.dispose()
