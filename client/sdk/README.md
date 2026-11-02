# SoduWork 即用 H5 桥

**简体中文** · [English](README.en.md) · [插件协议](../../docs/plugin-authoring.md)

SDK 1.6：当前用户、组织人员、对话/通知正文、本机/云资料只读接口。完整方法、权限、返回和分页契约见随包 `references/developer/references/host-data-sdk.md`；前端用 `soduWorkApp.user.getCurrent()`、`conversations.list/messages()`、`notifications.list()`、`library.list/read()`，不调用宿主私有API。页面只要求中英文；默认一个完整视觉主题，不强制明暗双模式。

SDK 1.4 新增：`data.get/list/batch/assetPut/assetGet`、公共 `mcp.connect`。宿主参数声明、SQLite、素材、MCP 绑定及鉴权建议，按需读取开发技能随包 `references/developer/references/host-sdk.md`。页面和后台工具共用宿主数据，窗口关闭不删除数据或计划。

## 读取外壳界面语言

声明 `context.read` 后，`await soduWorkApp.context.get()` 的回执提供 `locale`（例如 `zh-CN`、`en-US`），取自主窗口当前界面语言。原生应用和顶层显式授权的 iframe 共用该接口，继续执行来源与应用能力校验。业务页可用它初始化内置文案；旧外壳未返回语言或桥接不可用时，业务页自行回退英文。该接口不翻译业务数据、不改写页面用户手选的语言。

## 直接创建自动化（SDK 1.2）

应用清单单独声明 `automation.create`，页面即可在用户提交业务弹窗后调用：

机器人等持续执行业务应用复用此接口。即用页面严禁出现“自动化”按钮，入口、表单和状态用实际业务词语，例如“订阅简报”“定时整理”“每日汇报”；内部 `automation.create` 接口名不变。表单应明示时间、频率和操作范围，用户提交才创建；保存计划不代表业务执行成功，不以页面定时器替代宿主调度。该接口不提供计划查询、暂停或删除能力，不能编造相关 SDK 方法或用本地开关伪装操作成功。

```js
const receipt = await soduWorkApp.automation.create({
  text: '每天早上9点收集行业资料，保留来源和摘要',
  requestId: soduWorkApp.createRequestId(),
  context: {spaceId: currentSpaceId, spaceName: currentSpaceName, page: location.href}
});
if (!receipt.ok) throw new Error(receipt.reason);
// receipt.state === 'created'，receipt.schedule.id 是已保存计划的编号。
```

该入口复用 `/自动化` 的解析、能力绑定、时间校验、执行预检和正式 schedules API，直接保存，不打开待确认草稿卡片。普通聊天 `/自动化` 不受影响。正文最多8000字，原文和空间固定写入计划说明；空间信息不是额外业务授权，不复制应用凭据给计划。支持每天、每周指定一天、每小时、指定日期执行一次，未写时间默认北京时间每天18:00，页面应提前明示该默认值。不支持或不完整的时间、无可用执行底座、执行预检受阻时返回失败。

通过同一公共 SDK 支持已授权的直接 iframe；未声明能力、应用停用、来源改变或执行前使用权被撤销均拒绝创建。重试保留相同 requestId；不同正文不能复用编号。超时或创建传输失败返回 uncertain，应先核对自动化管理列表，不能盲目另发请求。创建成功表示计划已保存，不表示计划已执行或资料已入库；预检 waiting 会随回执返回。此入口需要新版原生主进程和工作区宿主，修改源码后重启客户端。

`soduwork-app.js` 是可直接复制到业务站点的公共 JS。即用壳负责当前即用的原生对话、权限和刷新；H5 不访问 Electron、设备凭据或原生会话 ref。

## 直接发送

插件基础信息中，外部页面的 `source.bridge.capabilities` 声明 `conversation.send` 与 `composer.control`。安装后从 SoduWork 的即用入口打开页面：

```html
<script src="soduwork-app.js"></script>
<script>
async function createTopic(description) {
  const result = await soduWorkApp.chat.send({
    text: '请在当前系列生成一个图文话题：' + description,
    requestId: crypto.randomUUID()
  });
  if (!result.ok) throw new Error(result.reason);
}
soduWorkApp.events.onRefresh(async () => {
  await reloadBusinessData();
});
</script>
```

成功回执表示消息被真实会话接受，不表示模型执行完成。生成任务只改业务记录，不把凭据放在正文或 URL 中。请求文字最多 8000 字符；同一次操作重试保留同一个 requestId，成功发送不会重复执行。发送失败时保留业务记录、单独补发任务；超时结果未知时先核对右侧对话。

## 跨域 iframe

应用顶层与直接嵌入的 iframe 各加载同一份 SDK。应用顶层显式授权业务来源：

```js
soduWorkApp.configure({allowedFrameOrigins: ['https://business.example']});
```

iframe 显式指定即用壳页面来源（默认尝试 document.referrer 的来源）：

```js
soduWorkApp.configure({parentOrigin: 'https://shell.example'});
const receipt = await soduWorkApp.chat.send({text: '处理当前记录', requestId: crypto.randomUUID()});
```

SDK 使用 `postMessage`，双方指定精确来源，顶层同时检查消息来源、实际 iframe 窗口及声明地址。不接受通配符或 opaque origin。允许发送、填入文本、展开/折叠对话、附件 ID／受限二进制分块及下述即用设置读写；不能从 iframe 转发 mcp.connect、本地路径或任意 IPC。

## 本地参考附件（SDK 1.3）

完整选择/取消/移除、同次重试、清理与业务上传说明见开发插件随包 `references/developer/references/local-files.md`。`attachments.pick` 通过原生桥触发壳文件选择器，返回引用元数据；它不返回字节或原始路径，不表示文件已上传到业务系统。页面要直接保存持久素材，应通过标准 File 获取字节后调用 `data.assetPut`，不能混用临时附件 ID 与持久素材 ID。

清单声明 `composer.control` 以选择、暂存、检查和释放附件，发送仍需 `conversation.send`。原生壳只将 ID、名称、MIME 和大小交给页面，原始路径留在主进程，ID 按即用页面实例隔离。

```js
const picked = await soduWorkApp.attachments.pick(); // {ok, items}; 取消时 items=[]
const pasted = await soduWorkApp.attachments.importFile(file, {signal, onProgress});
const ids = [...picked.items.map(item => item.id), pasted.id];
await soduWorkApp.attachments.check(ids);
const result = await soduWorkApp.chat.send({text:'参考附件完成任务', requestId:crypto.randomUUID(), attachmentIds:ids});
if (result.ok) await soduWorkApp.attachments.release(ids);
```

本地选择仅登记路径，不复制；粘贴和拖拽通过 1 MiB 分块传输到壳的临时目录，不转 base64、不主动上传云端。每个即用页面最多20个附件、合计256 MiB；不能使用整文件 IPC 绕过限制。源文件变化／删除、暂存未完成或未知 ID 会阻止发送。

发送通过原有 NativeChat 附件复制管线进入会话目录，不消费对话栏原有草稿或附件。接收回执表示会话发送已接受；请求去重同时包含文本和附件 ID 集合。移除引用应调用 release；关闭或整页跳转会释放应用附件，正在执行的复制持有独立占用，复制完成再清理临时源。只删除壳创建的暂存，不删除用户原文件，也不清理已复制的会话附件。关掉业务表单本身不等于关闭即用窗口。

2026-10-23 验证：附件／桥接／发送／生命周期模块回归与运营应用原生隔离端到端通过。完整客户端串行运行5108项，5105通过、1项启动器1000次替换压力测试失败、2项平台跳过；未修改的 native-launcher-swap 模块随后独立复跑3项全部通过，没有调整断言或跳过失败项。此前并行运行也出现网络／进程时序失败，不能把这些完整运行描述为全绿。原生端到端使用真实 SDK、IPC、磁盘暂存与会话复制，业务接口和对话接收为夹具，没有调用真实模型或发布。

原生标题栏“刷新”只重新加载即用页面，保留右侧会话及草稿。对话轮次结束由壳通知 `onRefresh`，业务页自行重新读取已授权的数据；失败和取消也可能结束轮次，数据刷新不等于执行成功。

需要业务完成通知时，由应用自己的接口登记 `requestId`，由业务技能在写入并读回后通过应用 MCP 保存结果回执，页面在 `onRefresh`、加载或聚焦时补读消息。业务 `type` 及 JSON 字段由技能与前端共同约定；服务端校验接收人和真实结果，前端使用已支持处理器展示通知／定位内容。重复消息去重，缺失回执保持待确认。此方案按需接入，不要求无账号轻即用建设消息服务。当前 SDK 未提供任意业务消息投递或 `onMessage`；宿主通用投递和即用开发插件／脚手架配套更新见 `docs/development/app-result-messages-backlog.md`（后续待办）。

本接口运行在 SoduWork 原生应用页或它授权的 iframe 中。普通外部浏览器页面没有即用壳时返回未连接，不注册或依赖自定义 URL 协议。

## 应用自定义设置（SDK 1.1）

应用自行定义参数名称、类型与业务含义；设置读写不要求业务登录或 MCP。新应用不要求、不推荐引入 ukey，认证由实际服务决定，旧即用已有凭据继续兼容。纯本地、单机或无账号应用可直接安装、打开并使用已声明的对话桥；不需要持久化时也不申请设置权限。

### 包内纯静态 H5

轻即用入口可声明为 `ui.contributions[].source: {"type":"package","entry":"ui/index.html","openMode":"workspace","bridge":{"version":1,"capabilities":["conversation.send","composer.control"]}}`。入口及相对引用的 HTML/CSS/JS/图片/JSON/字体都须包含在 `resources`（kind `ui` 或 `asset`）中；入口本身为 kind `ui`。导入后壳直接读取包内资源，不启动 HTTP 服务，不要求业务登录或 ukey。所有依赖随包提供，支持无外网运行。

使用相对路径和标准浏览器 API；localStorage/IndexedDB 按当前账号与应用隔离，关闭重开、同应用升版保留。壳能力仍通过本 SDK 的既有声明与原生桥调用，页面没有 Node.js 或文件系统权限。在线应用的 external/URL 模式继续兼容；包内脚本只在页面中执行，不会自动启动 Python/Node 后端。

本节是可选的业务登录集成示例。纯本地、单机或无账号应用无需登录、ukey、MCP 或设置读写权限，即可安装、打开并使用已声明的对话桥；不要为了使用即用窗口而增加认证。ukey 只是示例凭据名，实际认证由应用业务需求和所连接服务决定。SoduWork 自身的会话身份不等于应用业务账号。

### 包内纯静态 H5

轻应用入口可声明为 `ui.contributions[].source: {"type":"package","entry":"ui/index.html","openMode":"workspace","bridge":{"version":1,"capabilities":["conversation.send","composer.control"]}}`。入口及相对引用的 HTML/CSS/JS/图片/JSON/字体都须包含在 `resources`（kind `ui` 或 `asset`）中；入口本身为 kind `ui`。导入后壳直接读取包内资源，不启动 HTTP 服务，不要求业务登录或 ukey。所有依赖随包提供，支持无外网运行。

使用相对路径和标准浏览器 API；localStorage/IndexedDB 按当前账号与应用隔离，关闭重开、同应用升版保留。壳能力仍通过本 SDK 的既有声明与原生桥调用，页面没有 Node.js 或文件系统权限。在线应用的 external/URL 模式继续兼容；包内脚本只在页面中执行，不会自动启动 Python/Node 后端。

本节是可选的业务登录集成示例。纯本地、单机或无账号应用无需登录、ukey、MCP 或设置读写权限，即可安装、打开并使用已声明的对话桥；不要为了使用应用窗口而增加认证。ukey 只是示例凭据名，实际认证由应用业务需求和所连接服务决定。SoduWork 自身的会话身份不等于应用业务账号。

应用清单额外声明 `settings.read`、`settings.write`。接口只作用于当前已安装、启用的本机应用及其清单来源，页面不能传另一个应用 ID。设置按 SoduWork 登录账号、应用 ID、页面来源隔离，使用系统 safeStorage 加密保存，与“应用 → 应用设置”共用存储。不是 SSO，也不绑定两套用户体系。

```js
// 无需业务登录，即可保存任意符合限制的 JSON 参数。
const state = await soduWorkApp.settings.get();
if (!state.ok) throw new Error(state.reason);
const saved = await soduWorkApp.settings.update({
  values: {modelId: selectedModelId, theme: 'dark', options: {pageSize: 20}},
  expectedRevision: state.revision
});
if (!saved.ok) throw new Error(saved.reason);
```

`values` 支持字符串、数字、布尔、null、数组及嵌套 JSON 对象；最多 100 个参数、64 KiB、8 层，拒绝原型污染字段。更新合并顶层字段；删除用 `remove:['field']`。这保存参数值，不会自动生成设置表单，也不会自动向 MCP 或业务服务传参。

宿主设置弹窗中的普通表单沿用插件 `setup.preferences` 声明、`setupConfig` 安装配置及现有校验/保存链路；未声明时仅展示即用信息，不提供通用 JSON、默认模型或 ukey 输入。桥接设置用于页面自动同步及安全参数，不自动复制到安装偏好；未出现在设置界面的原凭据和值仍保留。敏感 Key 不可放入 `setup.preferences`。

用户填写的模型 API Key 等敏感字段应显式加入 `secretKeys`。普通读取及保存回执隐藏敏感字段；明确请求秘密须同时指定 `keys` 与 `includeSecrets:true`。自动名称检测只是补充，不能代替应用的敏感标记。不要把秘密写入日志、提示词、URL、公开 `context`、资源或导出包。

当前即用及顶层明确授权的直接 iframe 可按相同接口读写本即用设置；只授权可信业务来源。这不是 SoduWork 账号/设备令牌读取权限。无原生宿主、清单未声明权限、来源改变或应用停用时失败关闭。

### 按需业务认证与自有 MCP

仅在业务服务要求认证时接入其真实登录/授权方式。自动登录可保存服务签发的凭据及业务账号标识，重开时向原服务验证；页面退出只结束会话并暂停当前窗口自动登录，主动删除凭据使用 `remove`。换号时原子更新，并核对账号与 `expectedRevision`，避免旧异步响应覆盖新设置。服务端撤销/禁用仍生效，业务登录与宿主同步失败分别呈现。

顶层应用为已声明的自有 MCP 引用实际认证字段，凭据不经过模型。下面的 `credentialField` 是应用自己选定且已安全保存的字段名，并非固定名称：

```js
await soduWorkAppBridge.mcp.connect({
  server: 'my-declared-mcp', url: location.origin + '/mcp', credentialKey: credentialField,
  context: {spaceId: currentSpaceId}
});
```

`mcp.connect` 仍需单独声明；只允许该应用来源下的 `/mcp` 和已声明的连接器名称。宿主读取 `credentialKey` 对应的字符串，以 `Authorization: Bearer <应用服务凭据>` 认证，每轮生成可撤销的本机代理租约；真实凭据不写入 Agent 配置。账号或设置版本改变后旧租约拒绝后续调用，下一轮读取新设置。旧账号已被服务端接收的操作不能撤回；排队消息绑定提交时的设置版本，换号后须重新发送。远端 Hub 任务不代读本机安全存储。

当前 `credentialKey` 只映射 MCP 认证字段，不映射任意请求头或工具参数。模型 ID、供应商 Key 等额外配置不会自动随 MCP 调用发送；应用应通过其服务已实现的显式配置接口处理，不能把秘密塞进 `context` 或工具提示词。应用服务凭据与模型供应商 Key 用途不同，不应混用。


即用计划可传 `context.characterName`（可选，最多120字）；它表示角色名，非开发者或登录人。宿主补入已安装即用图标与名称，当前即用右侧保留创建卡和回执。创建成功不等于执行完成；查看自动化的执行记录确认。


### 同事目录与 @对话（SDK 1.5）
声明 `directory.read` 与 `notifications.send`。读取 `await soduWorkApp.directory.list()` → `{ok,members:[{id,name,orgId,org,canReceive}],orgUnits:[{id,name,parentId}],organizationDirectoryAvailable,truncated,reason}`。目录复用当前账号可见同事；不包含自己、凭据、手机号或邮箱。组织为可见在职成员所在部门。单次最多500项，truncated=true表示未完整列出；旧Hub缺组织ID时 organizationDirectoryAvailable=false，不能猜ID。

```js
const directory = await soduWorkApp.directory.list();
if (!directory.ok) throw Error(directory.reason);
const member = directory.members.find(row => row.id === selectedUserId && row.canReceive);
if (!member) throw Error('请选择可联系的同事');
const review = await soduWorkApp.chat.mention({
  recipientUserId: member.id, text: '请核对这份行动清单', requestId: crypto.randomUUID()
});
```

也可用 `query:'@姓名'`；按目录中首个精确姓名匹配打开卡片，无精确匹配时显示同事选择。稳定用户ID优先。text≤500字；保留原对话草稿，默认不勾选旧会话附件、不自动请求AI小结。返回 `{ok,opened,state:'review'|'select'}` 仅表示右侧卡片/选人已打开；需用户核对并点击“发送通知”，后续通知保存、送达、已读复用既有链路。失败返回reason；不得报告“已发送”。不解析普通 chat.send 文本中的 @，也不自动群发。每次新操作用新requestId；同ID同内容防重，不能用于新一次发送。

## 本地／云端数据声明

数据接口保持不变。新即用在顶层 `jiyong.storage` 显式声明 `{"location":"local"}` 或 `{"location":"cloud"}`，遵从创建时必选项；旧包省略仍用本地。云端需要包内版本化 `initialization.script` JSON，由 Hub 按稳定包身份和当前账号自动开通独立空间；页面与技能共用 `data.*`，不持有数据库密码、不执行随包服务脚本。预检只读检查云端就绪；安装／首次访问才初始化。未联网、未配置或撤权须报错，不能回退本地写库；写超时先读取核对。格式、迁移与证据要求见即用开发随包 `references/developer/references/cloud-data.md` 及同目录两个 JSON Schema。

## In-app one-shot AI

`ai.generate({input,instructions,requestId,maxOutputTokens:256,timeoutMs:30000})` (requestId, model, maxOutputTokens and timeoutMs are optional) requires `ai.generate`. It returns `{ok,text,model,usage,finishReason}` directly to the page, without a conversation, history, planner or tools. Host model authorization, quota and accounting still apply. Bundle each focused prompt with the app; see `skills/app-developer/references/fast-ai.md` for exact limits, errors and retry semantics. Never automatically retry uncertain responses.
