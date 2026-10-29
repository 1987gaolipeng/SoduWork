# SoduWork 应用 H5 桥

**简体中文** · [English](README.en.md) · [插件协议](../../docs/plugin-authoring.md)

## 读取外壳界面语言

声明 `context.read` 后，`await soduWorkApp.context.get()` 的回执提供 `locale`（例如 `zh-CN`、`en-US`），取自主窗口当前界面语言。原生应用和顶层显式授权的 iframe 共用该接口，继续执行来源与应用能力校验。业务页可用它初始化内置文案；旧外壳未返回语言或桥接不可用时，业务页自行回退英文。该接口不翻译业务数据、不改写页面用户手选的语言。

## 直接创建自动化（SDK 1.2）

应用清单单独声明 `automation.create`，页面即可在用户提交业务弹窗后调用：

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

`soduwork-app.js` 是可直接复制到业务站点的公共 JS。应用壳负责当前应用的原生对话、权限和刷新；H5 不访问 Electron、设备凭据或原生会话 ref。

## 直接发送

插件基础信息中，外部页面的 `source.bridge.capabilities` 声明 `conversation.send` 与 `composer.control`。安装后从 SoduWork 的应用入口打开页面：

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

iframe 显式指定应用壳页面来源（默认尝试 document.referrer 的来源）：

```js
soduWorkApp.configure({parentOrigin: 'https://shell.example'});
const receipt = await soduWorkApp.chat.send({text: '处理当前记录', requestId: crypto.randomUUID()});
```

SDK 使用 `postMessage`，双方指定精确来源，顶层同时检查消息来源、实际 iframe 窗口及声明地址。不接受通配符或 opaque origin。允许发送、填入文本、展开/折叠对话、附件 ID／受限二进制分块及下述应用设置读写；不能从 iframe 转发 mcp.connect、本地路径或任意 IPC。

## 本地参考附件（SDK 1.3）

清单声明 `composer.control` 以选择、暂存、检查和释放附件，发送仍需 `conversation.send`。原生壳只将 ID、名称、MIME 和大小交给页面，原始路径留在主进程，ID 按应用页面实例隔离。

```js
const picked = await soduWorkApp.attachments.pick(); // {ok, items}; 取消时 items=[]
const pasted = await soduWorkApp.attachments.importFile(file, {signal, onProgress});
const ids = [...picked.items.map(item => item.id), pasted.id];
await soduWorkApp.attachments.check(ids);
const result = await soduWorkApp.chat.send({text:'参考附件完成任务', requestId:crypto.randomUUID(), attachmentIds:ids});
if (result.ok) await soduWorkApp.attachments.release(ids);
```

本地选择仅登记路径，不复制；粘贴和拖拽通过 1 MiB 分块传输到壳的临时目录，不转 base64、不主动上传云端。每个应用页面最多20个附件、合计256 MiB；不能使用整文件 IPC 绕过限制。源文件变化／删除、暂存未完成或未知 ID 会阻止发送。

发送通过原有 NativeChat 附件复制管线进入会话目录，不消费对话栏原有草稿或附件。接收回执表示会话发送已接受；请求去重同时包含文本和附件 ID 集合。移除引用应调用 release；关闭或整页跳转会释放应用附件，正在执行的复制持有独立占用，复制完成再清理临时源。只删除壳创建的暂存，不删除用户原文件，也不清理已复制的会话附件。关掉业务表单本身不等于关闭应用窗口。

2026-10-23 验证：附件／桥接／发送／生命周期模块回归与运营应用原生隔离端到端通过。完整客户端串行运行5108项，5105通过、1项启动器1000次替换压力测试失败、2项平台跳过；未修改的 native-launcher-swap 模块随后独立复跑3项全部通过，没有调整断言或跳过失败项。此前并行运行也出现网络／进程时序失败，不能把这些完整运行描述为全绿。原生端到端使用真实 SDK、IPC、磁盘暂存与会话复制，业务接口和对话接收为夹具，没有调用真实模型或发布。

原生标题栏“刷新”只重新加载应用页面，保留右侧会话及草稿。对话轮次结束由壳通知 `onRefresh`，业务页自行重新读取已授权的数据；失败和取消也可能结束轮次，数据刷新不等于执行成功。

本接口运行在 SoduWork 原生应用页或它授权的 iframe 中。普通外部浏览器页面没有应用壳时返回未连接，不注册或依赖自定义 URL 协议。

## 应用设置与自动登录（SDK 1.1）

### 包内纯静态 H5

轻应用入口可声明为 `ui.contributions[].source: {"type":"package","entry":"ui/index.html","openMode":"workspace","bridge":{"version":1,"capabilities":["conversation.send","composer.control"]}}`。入口及相对引用的 HTML/CSS/JS/图片/JSON/字体都须包含在 `resources`（kind `ui` 或 `asset`）中；入口本身为 kind `ui`。导入后壳直接读取包内资源，不启动 HTTP 服务，不要求业务登录或 ukey。所有依赖随包提供，支持无外网运行。

使用相对路径和标准浏览器 API；localStorage/IndexedDB 按当前账号与应用隔离，关闭重开、同应用升版保留。壳能力仍通过本 SDK 的既有声明与原生桥调用，页面没有 Node.js 或文件系统权限。在线应用的 external/URL 模式继续兼容；包内脚本只在页面中执行，不会自动启动 Python/Node 后端。

本节是可选的业务登录集成示例。纯本地、单机或无账号应用无需登录、ukey、MCP 或设置读写权限，即可安装、打开并使用已声明的对话桥；不要为了使用应用窗口而增加认证。ukey 只是示例凭据名，实际认证由应用业务需求和所连接服务决定。SoduWork 自身的会话身份不等于应用业务账号。

应用清单额外声明 `settings.read`、`settings.write`。接口只作用于当前已安装、启用的本机应用及其清单来源，页面不能传另一个应用 ID。设置按 SoduWork 登录账号、应用 ID、页面来源隔离，使用系统 safeStorage 加密保存，与“应用 → 应用设置”共用存储。不是 SSO，也不绑定两套用户体系。

```js
// H5 用自己的登录接口取得 ukey 后，原子更新任意 JSON 业务参数。
const state = await soduWorkApp.settings.get();
const saved = await soduWorkApp.settings.update({
  values: {ukey: currentUserUkey, accountId: currentUserId, theme: 'dark'},
  secretKeys: ['ukey'], expectedRevision: state.revision
});
if (!saved.ok) throw new Error(saved.reason);

// 再次打开应用：明确读取自己应用的凭据，交给自己的服务验证后恢复登录。
const stored = await soduWorkApp.settings.get({keys: ['ukey'], includeSecrets: true});
if (stored.ok && stored.values.ukey) await loginToOwnService(stored.values.ukey);
```

`values` 支持字符串、数字、布尔、null、数组及嵌套 JSON 对象；最多 100 个参数、64 KiB、8 层，拒绝原型污染字段。更新合并顶层字段；删除用 `remove:['field']`。普通读取及保存回执隐藏凭据，`secretKeys` 标记的字段和含 ukey/token/password 等名称的字段会被隐藏；明确请求凭据时必须同时指定 `keys`。业务敏感字段应显式标记。不要把读取到的凭据写入日志、提示词、URL、资源或导出包。

当前应用及顶层明确授权的直接 iframe 可以按相同接口读取 ukey，用于页面自动登录；请只授权可信业务来源。此授权不是 SoduWork 账号/设备令牌读取权限。无原生宿主、清单未声明权限、来源改变或应用停用时失败关闭。

页面退出登录不删除壳内设置：只退出页面会话，并在当前窗口暂停自动登录；关闭后重开再读取 ukey。主动删除凭据需要明确 `remove`，服务端撤销/禁用仍立即拒绝使用。换号后一次写入新 ukey 与账号标识；异步请求在响应后核对当前页面登录账号，并使用 expectedRevision 避免旧请求覆盖新设置。服务器确认登录成功与壳同步失败需分别呈现，允许重试同步。

顶层应用为声明的自有 MCP 连接引用设置字段，凭据不经过模型：

```js
await soduWorkAppBridge.mcp.connect({
  server: 'my-declared-mcp', url: location.origin + '/mcp', credentialKey: 'ukey',
  context: {spaceId: currentSpaceId}
});
```

`mcp.connect` 仍需单独声明；只允许该应用来源下的 `/mcp` 和已声明的连接器名称。技能复用既有每轮 MCP 调用指南，壳注入 `Authorization: Bearer <ukey>`。每轮生成可撤销的本机代理租约，真实 ukey 不写入 Agent 配置；账号或设置版本改变后旧租约拒绝后续调用，下一轮读取新设置。旧账号已经被服务端接收的操作不能撤回。排队消息也绑定提交时的设置版本，换号后须重新发送。此自有 MCP/设置桥支持本机安装应用；远端 Hub 任务不代读本机安全存储。
