# 宿主数据 SDK 1.6

中文即用 / English App；只用随包 sdk/soduwork-app.js。旧客户端缺方法：明确提示升级，禁止编造接口、读取浏览器账号缓存、向页面暴露令牌或磁盘路径。

| 需求 | 页面方法 | source.bridge.capabilities |
| --- | --- | --- |
| 当前登录的SoduWork用户 | user.getCurrent() | context.read |
| 组织、人员 | directory.list() | directory.read |
| 全部可访问对话目录 | conversations.list({offset,limit,archived}) | messages.read |
| 对话正文 | conversations.messages({id,segmentId,offset,limit,after}) | messages.read |
| 收到/发出的通知正文 | notifications.list({source,folder,before,offset,limit}) | messages.read |
| 本机/云资料目录 | library.list({storage,folderId,query,offset,limit}) | library.read |
| 资料正文/原件分块 | library.read({id,format,offset,length}) | library.read |

每个调用以 soduWorkApp. 开头，例如：
```js
const me = await soduWorkApp.user.getCurrent();
if (!me.ok) throw Error(me.reason);
const userId = me.user.id; // 真实登录用户；不是操作系统用户名或人员列表第一项
const page = await soduWorkApp.library.list({storage:'local',limit:50});
if (!page.ok) throw Error(page.reason);
```

返回：getCurrent 的 user 含 id、username/name/displayName、orgId/orgName（宿主实际提供的字段）；context.get 是窗口/语言上下文，不能假设它已经包含登录用户。

分页：目录 limit 默认50、最大100；items 与 folders 分别分页，nextOffset=null结束。通知 source=server 读取全部服务端往来通知，folder=received/sent，下一页 before=nextCursor；source=center 读取当前通知中心已保存的提醒/审批等记录，按nextOffset分页。两种来源和通知箱分别读取，serverMessageId可去重。对话 archived=false/true 分开读取。必须检查 ok:false / reason，不能把空数组当作离线或权限通过。

对话：只读当前账号归属明确的会话，不启动模型、不恢复/切换用户对话。跨Agent会话返回 requiresSegment=true 和 segments；逐一用 segmentId 读取，禁止丢弃旧段。Pi 返回 format=messages，用户/助手 text 正文、nextOffset；单条与每页文字最多1MB，原存档最多128MB，超限明确失败、不静默截断；非文本内容用 hasNonTextContent 标记，不把系统提示、工具秘密或文件路径作为附件下载能力。Runner 返回 format=events，以 after=nextAfter 读取全部事件；delta=true按streamId拼接、delta=false替换同流全文，done标记完成。原生底座不可达、云端已接收会话也返回format=events/nextAfter；底座离线、旧会话归属不明应明确报错，不能假装已读完。

资料：storage=local(本机)/minio/nfs(已配置云存储)，不能假设云库只有一种。内容 format=text 时 offset/length 按字符；format=base64 时按原件字节，先解码每块再拼字节，不能直接拼接base64字符串。length默认65536、最大262144，nextOffset=null结束，正文渲染用textContent，不执行HTML。预览被截断时改读原件，不把预览当全文；不支持的格式/过大文件明确报错。

组织/人员/资料/消息沿用SoduWork当前账号和原服务权限；跨账号响应丢弃。没有新增即用间审批；每包按需声明只读能力，服务端账号权限继续有效。仅声明能力不会自动给AI业务工具：需要AI处理时，把最少必要正文交给当前即用会话及随包业务技能，不放凭据。

## 数据更新订阅
```js
const off = soduWorkApp.events.onDataChanged(({topic}) => {
  // topic: identity / notifications / conversations / library
  // identity：清空旧账号数据和游标；其他topic：在当前账号下补读。
});
// 页面组件卸载时 off()；关闭窗口会释放整个订阅。
```
复用宿主通知持久化、会话轮次完成及资料变化事件，只推送数据变化提示，不推送正文、令牌或任意账号信息。窗口关闭期间由原服务保存消息，重开必须补读；事件不是“每条消息已送达”的回执。即用自己决定群组、成员关系和归组规则，宿主不建立群聊业务模型。

主题按声明能力过滤：identity 需 context.read；通知/对话需 messages.read；资料需 library.read。数据型即用应声明 context.read 并处理 identity，切号不沿用旧数据或游标。
