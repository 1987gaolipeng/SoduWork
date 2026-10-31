'use strict';
const {parentPort,workerData} = require('node:worker_threads');
const {DatabaseSync,backup} = require('node:sqlite');
const fs = require('node:fs');
fs.mkdirSync(require('node:path').dirname(workerData.file),{recursive:true,mode:0o700});
const db = new DatabaseSync(workerData.file);
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
const version = db.prepare('PRAGMA user_version').get().user_version;
if (version > 2) throw Error('即用数据库来自更新版本，请升级 SoduWork');
if (version < 2) db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE IF NOT EXISTS records(collection TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL,updatedAt TEXT NOT NULL, PRIMARY KEY(collection,id));
 CREATE TABLE IF NOT EXISTS jiyong_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,appliedAt TEXT NOT NULL);
 PRAGMA user_version=2; COMMIT;`);
const contract = require('../core/jiyong-contract.cjs');
const declaration = contract.normalize(workerData.declaration);
for (const c of declaration.collections) for (const field of c.indexes) {
  // Names were validated before interpolation; values in queries are still bound.
  db.exec(`CREATE INDEX IF NOT EXISTS "idx_${c.key}_${field}" ON records(collection,json_extract(value,'$.${field}'),id)`);
}
const read = (c,id) => {
  const row = db.prepare('SELECT id,value,revision,updatedAt FROM records WHERE collection=? AND id=?').get(c,id);
  return row ? {...row,value:JSON.parse(row.value)} : null;
};
// Every pending migration and its seeds commit together. Existing records,
// including tombstones, always win over initial data.
const script=workerData.initialization || {migrations:[]};
const canonical=value=>JSON.stringify(value,(_,v)=>v && typeof v==='object' && !Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
db.exec('BEGIN IMMEDIATE');
try{
 for(const step of script.migrations){
  const checksum=require('node:crypto').createHash('sha256').update(canonical(step)).digest('hex');
  const previous=db.prepare('SELECT checksum FROM jiyong_migrations WHERE version=?').get(step.version);
  if(previous){if(previous.checksum!==checksum)throw Error('已执行的数据初始化脚本被修改，请追加新的迁移版本');continue;}
  for(const row of step.seed)db.prepare('INSERT OR IGNORE INTO records VALUES(?,?,?,?,?)').run(row.collection,row.id,JSON.stringify(row.value),1,new Date().toISOString());
  db.prepare('INSERT INTO jiyong_migrations VALUES(?,?,?)').run(step.version,checksum,new Date().toISOString());
 }
 db.exec('COMMIT');
}catch(error){db.exec('ROLLBACK');throw error;}
async function run(method, input) {
  if(method==='initialize')return {ok:true,state:'ready',databaseVersion:2,migrationVersion:db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM jiyong_migrations').get().version};
  if (method === 'backup') { await backup(db,workerData.file + '.backup'); return {ok:true}; }
  if (method.startsWith('data.asset')) {
    const p = contract.assetRequest(method,input), path = require('node:path'), crypto = require('node:crypto');
    const directory = path.join(path.dirname(workerData.file),'assets');
    if (method === 'data.assetPut') {
      const bytes = Buffer.from(p.data), id = 'asset_' + crypto.createHash('sha256').update(p.name+'\0'+p.type+'\0').update(bytes).digest('hex');
      fs.mkdirSync(directory,{recursive:true,mode:0o700});
      const file = path.join(directory,id);
      const meta = {id,name:p.name,type:p.type,size:bytes.length};
      const content = Buffer.concat([Buffer.from(JSON.stringify(meta)+'\n'),bytes]);
      const temporary = file + '.next-' + crypto.randomUUID();
      try {
        const fd = fs.openSync(temporary,'wx',0o600);
        try { fs.writeFileSync(fd,content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        try { fs.linkSync(temporary,file); }
        catch (error) { if (error.code !== 'EEXIST' || !fs.readFileSync(file).equals(content)) throw error; }
      } finally { fs.rmSync(temporary,{force:true}); }
      return {ok:true,asset:meta};
    }
    const file = path.join(directory,p.id);
    let content;
    try { if (fs.statSync(file).size > 8*1024*1024+1024) throw Error('素材过大'); content = fs.readFileSync(file); }
    catch (error) { if (error.code === 'ENOENT') return {ok:true,asset:null}; throw error; }
    const split = content.indexOf(10), asset = JSON.parse(content.subarray(0,split).toString());
    const bytes = content.subarray(split+1);
    const hash = 'asset_'+crypto.createHash('sha256').update(asset.name+'\0'+asset.type+'\0').update(bytes).digest('hex');
    if (hash !== p.id || asset.size !== bytes.length) throw Error('即用素材校验失败');
    return {ok:true,asset,data:new Uint8Array(bytes)};
  }
  const p = contract.dataRequest(method,input,declaration);
  if (method === 'data.get') {
    const row = read(p.collection,p.id);
    return {ok:true,item:row?.value === null ? null : row,revision:row?.revision || 0};
  }
  if (method === 'data.list') {
    const fields = Object.keys(p.filter);
    const query = "SELECT id,value,revision,updatedAt FROM records WHERE collection=? AND id>? AND value<>'null'" + fields.map(k => ` AND json_extract(value,'$.${k}') IS ?`).join('') + ' ORDER BY id LIMIT ?';
    const items = []; let size = 0, more = false;
    for (const row of db.prepare(query).iterate(p.collection,p.after,...fields.map(k => typeof p.filter[k] === 'boolean' ? Number(p.filter[k]) : p.filter[k]),p.limit + 1)) {
      if (items.length >= p.limit || (items.length && size+Buffer.byteLength(row.value)>1024*1024)) { more=true;break; }
      size += Buffer.byteLength(row.value); items.push({...row,value:JSON.parse(row.value)});
    }
    return {ok:true,items,next:more ? items.at(-1).id : null};
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const items = p.operations.map(op => {
      const current = read(p.collection,op.id);
      if ((current?.revision || 0) !== op.expectedRevision) throw Object.assign(Error('数据已更新，请重新读取后合并'),{code:'JIYONG_CONFLICT'});
      const revision = (current?.revision || 0) + 1, updatedAt = new Date().toISOString();
      db.prepare('INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value,revision=excluded.revision,updatedAt=excluded.updatedAt').run(p.collection,op.id,op.delete ? 'null' : JSON.stringify(op.value),revision,updatedAt);
      if (op.delete) return {id:op.id,deleted:true,revision};
      return {id:op.id,value:op.value,revision,updatedAt};
    });
    db.exec('COMMIT'); return {ok:true,items};
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
// Serialize async backup with writes as well as ordinary SQLite statements.
let tail = Promise.resolve();
parentPort.on('message', ({id,method,params}) => {
  tail = tail.then(() => run(method,params)).then(result => parentPort.postMessage({id,result},result.data?.buffer instanceof ArrayBuffer ? [result.data.buffer] : []),error => parentPort.postMessage({id,error:{message:error.message,code:error.code}}));
});
