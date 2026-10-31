"""Validate inert first-install seed scripts inside the immutable package."""
import base64
import json
from . import jiyong_contract as contract

def parse(declaration,resources):
    reference=(declaration or {}).get('initialization')
    if not reference:return {'schemaVersion':1,'migrations':[]}
    file=next((r for r in resources if r['path']==reference['script']),None)
    if file is None:raise ValueError('初始化脚本未随包提供')
    data=file['content'].encode('utf-8') if file.get('encoding')=='utf8' else base64.b64decode(file['content'],validate=True)
    if len(data)>1024*1024:raise ValueError('初始化脚本最多1MiB')
    raw=json.loads(data.decode('utf-8'));contract.only(raw,['schemaVersion','migrations'])
    migrations=raw.get('migrations')
    if type(raw.get('schemaVersion')) is not int or raw['schemaVersion']!=1 or not isinstance(migrations,list) or len(migrations)>100:raise ValueError('初始化脚本版本或迁移数量无效')
    count=0
    for index,step in enumerate(migrations):
        contract.only(step,['version','seed'])
        if type(step.get('version')) is not int or step['version']!=index+1 or not isinstance(step.get('seed'),list):raise ValueError('数据迁移版本必须从1连续递增')
        seen=set()
        for row in step['seed']:
            contract.only(row,['collection','id','value']);count+=1
            collection=contract.key(row.get('collection'));identity=(collection,contract.key(row.get('id')))
            if count>1000 or not any(c['key']==collection for c in declaration['collections']):raise ValueError('初始数据集合未声明或数量超限')
            if identity in seen:raise ValueError('初始数据记录标识重复')
            seen.add(identity)
            if not isinstance(row.get('value'),dict):raise ValueError('初始数据值须为 JSON 对象')
            contract.json_value(row['value'])
    return raw
