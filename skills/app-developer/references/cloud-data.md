# 即用本地／云端数据声明 v1（SDK 1.6）

## 位置与身份

创建入口必须二选一“数据云存储／数据本地化”，所选模式进入开发会话。生成的新即用必须显式声明 `jiyong.storage.location`；`local` 用现有宿主 SQLite，`cloud` 用 Hub 托管的独立 PostgreSQL 业务库。旧包省略 storage 继续本地，不自动上传、迁移或双向同步。

存储位置与页面来源分别声明：cloud 仍可使用默认包内 HTML/CSS/原生 JS，不必改成 external 页面或部署一个业务后端。数据服务由宿主统一提供。

数据库展示名称取草稿顶层稳定 `key`（包名），不是可变的 `name`。Hub 以企业根组织／账号和稳定安装包身份分配独立 schema，空间内有自己的集合、索引、记录、迁移和素材元数据；不要传数据库名、ownerId、连接串或任意 SQL。不同账号／企业隔离，同一账号多设备共用，企业内调部门不换空间。当前没有企业多人共享空间开关；跨即用数据发现／读写沿用同账号安装授权，凭据不共享。个人包转市场包不自动合并空间，需要单独的数据迁移授权。

## 草稿 JSON

这是顶层 `jiyong` 字段，不是 setup/preferences/ui 的子字段。完整机器格式见 [jiyong-data.schema.json](jiyong-data.schema.json)，初始化格式见 [data-initialization.schema.json](data-initialization.schema.json)。运行时校验器是安装规则的权威；Schema 只辅助编辑，不取代包资源和权限验证。

新稿的 JSON Schema 与 `scripts/validate.cjs` 要求显式 storage；旧包的运行时导入仍允许省略并按 local 处理。修改旧包时补充 local 声明不会改变其稳定数据空间。

```json
{
  "template": "app",
  "key": "customer-manager",
  "version": "0.1.0",
  "jiyong": {
    "version": 1,
    "storage": {"location": "cloud"},
    "parameters": [],
    "collections": [{"key": "customers", "indexes": ["status"]}],
    "mcp": {"server": "soduwork-jiyong", "bindings": []},
    "initialization": {"script": "assets/data-init.json"}
  }
}
```

这是数据片段，完整即用仍须有名称、说明、业务技能、图标、UI、资源等字段。`mcpServers` 声明 `soduwork-jiyong`，唯一包内入口桥声明 `mcp.connect`、`data.read`、`data.write`。纯页面无需 MCP 时可省略 mcp。不要使用不存在的 `data.location`、`databaseName`、`backendScript` 字段。

## 初始化与升级 JSON

`assets/data-init.json` 必须真实随包，kind=asset。云端必须声明初始化，空库也用下面结构并令 seed=[]。脚本为声明式 JSON，不执行 SQL、Shell、Python、JS 或任意安装钩子。

```json
{
  "schemaVersion": 1,
  "migrations": [
    {"version": 1, "seed": [
      {"collection": "customers", "id": "welcome", "value": {"title": "示例客户", "status": "example"}}
    ]}
  ]
}
```

- 迁移 version 从 1 连续递增，升级追加步骤，保留所有历史步骤及引用集合；已经执行的步骤不可改写。每次更改包内容提升应用 SemVer。
- 单脚本≤1MiB、迁移≤100、总种子≤1000、每条 JSON≤64KiB；集合必须已声明，单步不能重复 collection/id。标识以字母开头，只含字母、数字、下划线、短横线，≤64字符；禁止 __proto__/prototype/constructor。
- 自动开通／全部待执行步骤在一个数据库事务中提交，版本摘要持久化；重复安装、首次打开并发、重试不重复初始化。已有记录（含删除墓碑）优先，seed 永不覆盖用户记录；它不是批量 UPDATE 或任意数据变换脚本。
- 增加集合／索引不清空数据，删除声明不删除历史记录。较旧初始化版本无法覆盖较新云端数据；失败回滚、不报 ready，允许修复后重试。默认卸载保留数据；本轮没有用户删除／备份恢复 SDK。

## 页面、技能与素材

两种位置统一使用 `soduWorkApp.data.apps/get/list/batch/assetPut/assetGet`，技能使用真实宿主 MCP `data_apps/data_get/data_list/data_batch`。页面无数据库连接权限，模型不接收设备凭据；宿主绑定实际账号和已安装版本。云端每次重新鉴权，市场包的声明和脚本由 Hub 从不可变已安装版本读取，不相信网页上传的替代声明。

get 返回 item/revision；list 按 id 分页、limit=1～200、after 使用 next，filter 只用已声明索引标量；batch=1～100条原子 CAS，新建 expectedRevision=0，删除也保留 revision。冲突重新读取合并，不盲目重发。素材单个≤8MiB，记录保存 asset.id；云端字节放持久素材目录，数据库存元数据，不塞进 JSON。

云端联网失败／未登录／后台未配置／权限撤销都显示真实原因，禁用依赖操作并可重试，不回退写本机。写请求超时可能已经提交，先 get 读回确认。纯 UI 计算仍直接执行，不为每次点击调用 AI。

## 预检与交付

1. 校验声明未知字段、location、权限、真实初始化资源、版本连续性、集合和大小限制；失败阻止安装。
2. 云端预检只读 `GET /api/v1/jiyong/status` 检查账号、独立数据库迁移及存储配置，不创建真实空间、不播种数据。未就绪必须阻止安装。
3. 安装预检不启动应用页面或执行首屏数据检查。开发者需要时单独运行原生诊断，其隔离数据替身不能证明真实云端读写。
4. 用户安装／打开时由宿主自动 POST 数据请求准备空间，初始化成功才允许依赖操作。页面和技能访问同一云端空间；重开读回。
5. 静态成功、隔离首屏成功、实际云端写回读回分别报告，不能混称。云端存储不意味着本机技能可以在关机后运行，云端执行仍需现有 Runner 与授权。

运维首次配置独立业务数据库和素材目录后，所有应用按声明自动开通；这一步是平台部署配置，不能转嫁为每个即用的手工建库步骤。运行环境部署规范见仓库 `docs/operations/jiyong-cloud-data.md`。
