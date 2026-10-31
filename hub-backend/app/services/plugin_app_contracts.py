"""Additive app discriminator; legacy UI plugins retain their existing shape."""
from urllib.parse import urlsplit


APP_CATEGORIES = ('office', 'game', 'robot', 'other')

def category(value):
    if value is None or value == '':
        return 'other'
    if not isinstance(value, str) or value not in APP_CATEGORIES:
        raise ValueError('请选择有效的即用分类')
    return value

def validate(template, ui):
    if template != 'app':
        return
    pages = [item for item in (ui or {}).get('contributions', [])
             if item.get('slot') == 'workspace.navigation'
             and item.get('source', {}).get('type') in ('external', 'package')]
    if not any(item['source'].get('openMode') != 'external' for item in pages):
        raise ValueError('即用必须声明 ui.contributions 中的 workspace.navigation 网页地址或包内页面，并由即用壳打开')
    for item in pages:
        if item['source']['type'] == 'package':
            continue
        url = urlsplit(item['source']['url'])
        if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password:
            raise ValueError('即用页面需要不含账号或密码的有效 HTTP(S) 地址')


def validate_resources(ui, resources):
    available = {row['path'] for row in resources if row.get('kind') == 'ui'}
    for item in (ui or {}).get('contributions', []):
        source = item.get('source', {})
        if source.get('type') == 'package' and source.get('entry') not in available:
            raise ValueError('包内页面入口未包含在 ui 资源中：' + str(source.get('entry')))
