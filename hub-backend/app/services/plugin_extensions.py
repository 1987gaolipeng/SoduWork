"""Preserve unknown public metadata without granting executable capabilities."""
import copy
import json
import math
import re

def normalize(raw):
    if raw is None:
        return None
    if not isinstance(raw,dict) or len(raw)>32:
        raise ValueError("扩展元数据需要命名空间对象，最多32项")
    nodes=0
    def walk(value,depth):
        nonlocal nodes
        nodes+=1
        if nodes>2000 or depth>8:
            raise ValueError("扩展元数据嵌套或数量超限")
        if value is None or isinstance(value,(str,bool)):
            return
        if isinstance(value,(int,float)):
            if (isinstance(value,int) and abs(value)>9007199254740991) or (isinstance(value,float) and (not math.isfinite(value) or (value.is_integer() and abs(value)>9007199254740991))):
                raise ValueError("扩展元数据必须是有限 JSON")
            return
        if isinstance(value,list):
            for item in value:walk(item,depth+1)
            return
        if not isinstance(value,dict):
            raise ValueError("扩展元数据必须是有限 JSON")
        for key,item in value.items():
            if not isinstance(key,str) or not key or len(key)>160 or key in {"__proto__","prototype","constructor"}:
                raise ValueError("扩展元数据字段无效")
            walk(item,depth+1)
    for namespace,value in raw.items():
        if not isinstance(namespace,str) or not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_.-]{0,79}",namespace) or not isinstance(value,dict):
            raise ValueError("扩展元数据命名空间无效")
    walk(raw,0)
    if len(json.dumps(raw,ensure_ascii=False,separators=(",",":"),allow_nan=False).encode('utf-8'))>16384:
        raise ValueError("扩展元数据最多16KiB；文件请使用资源声明")
    return copy.deepcopy(raw)
