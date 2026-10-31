# 宿主 SDK 1.6：即用数据与参数

本文接口对应 client/sdk/soduwork-app.js。先读取本轮同源 SDK，不假设旧客户端支持新接口。

## 启动与连接

SDK 文件加载≠已连接；没有 `soduWorkApp.connect()`。原生桥由宿主注入，不能由页面申请 capabilities（权限在包声明）。正式包从“即用→我的”打开，不能以 file:// 或开发预览代替。

```js
const context = await soduWorkApp.context.get(); // 声明 context.read
if (!context?.ok) throw Error(context?.reason || '宿主确认失败');
const page = await soduWorkApp.data.list({collection:'notes',limit:50});
if (!page?.ok) throw Error(page?.reason || '数据读取失败');
```

连接失败、权限不足、参数错误、SQLite 失败分别呈现原始 reason；不能一律显示“未连接壳”。禁用依赖项并允许重试；不得 catch 后切换 localStorage/IndexedDB 写业务数据。外部浏览器仅允许明确的演示模式，样例只放内存、注明不保存；2.5秒无响应不是“无宿主”的证明，超时也不证明写操作未执行。完整顺序见 development-workflow.md。

## 前端和后端选择

默认：template:"app"＋source.type:"package"；ui/index.html 与 JS/CSS/字体完整随包，使用相对路径，无 CDN、临时端口或独立数据库安装。原生隔离窗口由 SoduWork 打开，页面无 Node/任意 IPC/磁盘权限。用户选中的目录可以为空，业务数据不放该目录。

纯 UI 计算无需后端；本机持久数据用宿主 data；AI小任务用 ai.generate（见 fast-ai.md），工具执行用 chat.send；持续任务用已有 automation；在线多人业务保留真实业务 API。确需自定义业务服务时按真实部署方式交付，不能只生成脚本就声称宿主会自动启动它；当前宿主不自动执行随包服务脚本。

## 声明

```json
{
  "jiyong": {
    "version": 1,
    "parameters": [
      {"key":"layout","label":"布局","type":"string","display":"select","options":["compact","comfortable"],"default":"compact"},
      {"key":"serviceKey","type":"string","display":"hidden","secret":true}
    ],
    "collections": [{"key":"notes","indexes":["status"]}],
    "mcp": {"server":"soduwork-jiyong","bindings":[]}
  },
  "mcpServers": ["soduwork-jiyong"]
}
```

放在草稿顶层；不是 setup.preferences 或 ui 的子字段。宿主 MCP 需唯一包内 workspace.navigation 入口，其 source.bridge.capabilities 至少包含 mcp.connect 和所需 data.read/data.write；页面另声明 settings.read/settings.write、conversation.send/composer.control、automation.create 等实际能力。

## 参数与设置

值类型：string / number / boolean / array / object。

显示类型：text、textarea、number、switch、select、multiselect、password、hidden。text/textarea/password/select→string；number→number；switch→boolean；multiselect→array；hidden 可存任一值类型。select/multiselect 使用 options 字符串数组。

secret 独立于 hidden；隐藏只控制设置界面，不代表秘密。secret:true 禁止默认值；密码控件留空保留旧值。普通默认值随版本，用户覆盖优先。宿主设置面板显示声明的可见字段；即用也可内置自定义设置页，用同一 SDK 随时更新。

```js
const current = await soduWorkApp.settings.get();
if (!current.ok) throw Error(current.reason);
const updated = await soduWorkApp.settings.update({
  values: {layout:'comfortable'}, expectedRevision:current.revision
});
if (!updated.ok) throw Error(updated.reason);
```

get：{keys?,includeSecrets?}；默认秘密仅返回 configuredKeys/secretMasks，不返回值。显式读自己的秘密须指定 keys。update：{values?,remove?,secretKeys?,expectedRevision?}；类型/声明校验，CAS 冲突后重读。命名任意合法 key；示例 serviceKey 无固定业务含义。密钥进系统安全存储，不能进入 URL、提示词、交付包或普通日志。

## SQLite 持久化

权限 data.read→apps/get/list；data.write→batch。每个即用独立数据库，存于宿主用户目录；SoduWork 账号隔离，同账号即用业务数据互通，无跨即用 ACL 或逐次确认；后台 Worker 执行，WAL/索引/分页/原子事务，不整表写 JSON。关闭窗口和升级保留数据；不依赖页面缓存或当前工作目录。不自动跨机器同步。JSON 记录不放大文件或秘密参数。

```js
const saved = await soduWorkApp.data.batch({collection:'notes',operations:[
  {id:'note_one',expectedRevision:0,value:{title:'今天',status:'open'}}
]});
const page = await soduWorkApp.data.list({collection:'notes',limit:50,filter:{status:'open'}});
const row = await soduWorkApp.data.get({collection:'notes',id:'note_one'});
```

跨即用：`await soduWorkApp.data.apps()` → `{ok,apps:[{appId,name,collections}],remoteUnavailable}`；用返回的 appId 调用 `data.get/list/batch/assetPut/assetGet({...参数,appId})`，读写同账号目标即用的声明集合；省略 appId 操作自己。先发现真实 appId，不能猜目录、传账号或使用任意 SQL。集合规则取目标声明；并发修改仍用 revision。凭据不经数据发现或跨即用读取。

所有回执先检查 ok，失败显示 reason；桥调用也可能 reject，应 catch 并保留输入。

- get → {ok,item:{id,value,revision,updatedAt}|null,revision}；删除保留修订号，复用该 id 时使用返回的 revision，首次从未使用的 id 为0，避免旧客户端覆盖重建记录。
- list → {ok,items,next}；limit 1–200，第一页省略 after（新版也接受空串/null）；翻页 after 只传上页非空 next；按 id 正序，filter 仅声明索引字段的等值标量。最大20集合，每集合8索引。
- batch → {ok,items}；1–100操作、整批≤64KiB；新增 expectedRevision:0，修改/删除必须用刚读取的 revision；删除 {id,expectedRevision,delete:true}；任一冲突整批回滚。不自动覆盖重试。
- id/集合/索引：字母开头，字母数字下划线短横，≤64字符；自己生成稳定业务 id。
- 素材：data.assetPut({name,type,data:Uint8Array}) → {ok,asset:{id,name,type,size}}；data.assetGet({id}) → {ok,asset,data}，不存在时 asset:null。单文件≤8MiB，落宿主磁盘并校验摘要；记录只保存 asset.id，不保存大段 Base64。需要显示时用返回字节构建 Blob/ObjectURL，使用完释放 URL。
- 当前结构版本1；增加集合/索引不重建数据，删除声明不会删除磁盘记录。不提供页面任意 SQL、磁盘路径或恢复覆盖接口。内部备份不等于用户已完成外部备份。

## 本地 MCP

soduwork-jiyong 是按安装版本接入的宿主 MCP；业务数据按当前 SoduWork 账号共享，秘密设置不共享。无需页面手动 connect。页面和 MCP 共用上述数据库，窗口关闭可继续。工具：data_apps、data_list、data_get、data_batch；参数与 SDK 相同；tools/list 给出真实 inputSchema。先读取→合并→带 revision 写入→读取确认。连接随每轮授权创建/撤销，不把数据库路径和宿主凭据交给模型。

bindings 声明 {tool,argument,parameter}，例如把 data_list 的 collection 绑定到名为 currentCollection 的普通隐藏参数；宿主取当前值或默认值注入，不执行 {sk} 模板表达式；本地数据工具禁止绑定秘密参数，避免把秘密写入业务记录。在线 MCP 同样支持 bindings：模型工具清单移除宿主绑定字段，调用时覆盖模型传入值，宿主注入当前参数；秘密须为非空字符串，服务回显脱敏。bearer 使用 credentialKey 引用秘密参数，不把 secrets 拼进提示词。绑定模式使用 POST JSON-RPC、有限长度 JSON/SSE 响应，不提供长驻 GET 事件流；服务需支持该传输。

## 鉴权推荐

在线用户授权优先服务支持的 OAuth 授权码＋PKCE，核对 state/回调/令牌作用域及到期；简单业务可用服务端颁发的可撤销、最小权限 token/API key，通过安全设置参数和 credentialKey 使用。宿主桥授权与业务服务鉴权分别校验。业务端仍需校验账号和资源权限；客户端隐藏字段不能替代服务端权限检查。不要内置永久共享密钥。

接入在线 H5：现有 mcp.connect 的 server 必须在 mcpServers 声明；url 必须为已安装页面同源 /mcp，无查询/片段/凭据；credentialKey 是参数名，宿主动态取值注入 bearer。不把其他参数自动当成鉴权或自动透传。

## AI 与持续执行

chat.send/insertText/expand/collapse 见 sdk/README.md；业务技能使用本轮授权工具，结果写上述存储，页面 onRefresh/加载/聚焦重新读取。发送成功只代表接收，真实数据回执才代表完成。

automation.create 复用现有 Hub/Runner 调度。页面用“订阅简报”“每天整理”等业务操作名，提交时间/频率/范围后创建，保留 requestId 防重。根级显式声明 entrypoints:{automation:true}；本机即用和已安装市场宿主即用的计划固定身份/版本/校验值，不把密钥写入计划。市场即用使用宿主生成的目录标识定位；缺少执行条件必须报阻塞；不能靠页面 setInterval，也不能在页面关闭时删除计划。执行设备/SoduWork 需要在线，页面窗口可关闭；不宣称关机继续本地执行。当前 SDK 没有计划列表/暂停/删除方法，不能编造。


## 开发者与角色
- 开发者：草稿顶层 `author`；设置可改、升版保存；导出/审核/导入保留。
- 角色：可选；与开发者、SoduWork 登录账号分别保存。
- 创建计划：`automation.create({text,requestId,context:{characterName:'阿奇'}})`；无角色省略。
- 即用图标/名称由宿主从已安装版本读取；不允许页面冒充其他即用。自动化卡只呈现图标、名称、可选角色，无来源标签。
- 创建由当前即用右侧会话工作卡保留进度与回执；创建成功不是执行完成。超时核对计划，勿自动重发。
- 修改：设置→修改即用；新开发对话复用即用开发插件，完整源码、稳定 key、升版、检查安装；不回原创建会话。

- 扩展元数据：顶层 `extensions:{"studio.example":{schemaVersion:1,...}}`；公开 JSON≤16KiB、深度≤8。命名空间自管版本；未知字段原样保留；修改 author 不清除扩展；扩展不授予运行权限、不放凭据。


## 数据初始化
- 脚手架：`--storage true`；生成 `assets/data-init.json`（kind=asset），声明 `jiyong.initialization:{script:'assets/data-init.json'}`。
- 脚本：声明式 JSON，非 JS/SQL 安装钩子；`{schemaVersion:1,migrations:[{version:1,seed:[{collection:'notes',id:'welcome',value:{title:'示例',status:'active'}}]}]}`。
- 版本从1连续追加；旧版本内容不可改；空种子用 `seed:[]`。首次安装由宿主建表、建索引、事务灌入；目录为空正常。
- 单脚本≤1MiB、迁移≤100、总记录≤1000；每条 JSON≤64KiB。集合必须已声明；初始素材标记示例，不包含凭据或用户业务数据。
- 重装/重开不重复写；升级只执行新增迁移；已有记录与删除墓碑优先，不覆盖或复活。失败整批回滚，可修复后重试。
- 登录账号隔离，每个账号分别初始化；未登录安装为 pending_account，首次获知账号后执行。页面/后台 MCP 首次访问同样兜底。
- 安装成功不冒充业务验收；验证首次安装、重装、升级、修改过的种子、删除、失败回滚、账号切换及包内脚本完整性。

固定元数据：`author`=开发者；`appCategory`=office/game/robot/other（工具办公/小游戏/机器人/其他）；未分类显示其他。设置或申请上架可选择分类，修改生成新版本；签名、包、审核、导入保留两个字段。`category` 为既有工作方法/市场治理字段，不混用。脚手架 `--category office`。


## 组织与同事提及（SDK 1.6）
- `directory.read` → `soduWorkApp.directory.list()`；当前账号目录、部门ID、成员稳定ID、canReceive；500项上限/truncated，旧Hub组织ID不可用则明确提示，不猜ID。
- `notifications.send` → `soduWorkApp.chat.mention({recipientUserId,text,requestId})`；或query按姓名查找，不增加重名处理流程。
- 复用当前即用右侧@卡片；text≤500；保留草稿；默认不携带旧成果、不付费总结；先核对后发送。
- review/select≠已发送；保存/送达/已读取原通知回执。普通chat.send不解析@；不另造用户/通知体系、不自动群发。
