---
name: browser-use
description: Use when a real web page must be opened, inspected, interacted with, or validated end to end without connecting to the user's existing browser.
---

# Browser Use

用项目脚本通过 Chrome DevTools Protocol 驱动**自己启动的隔离浏览器**。零依赖，只用 Node 22+ 内置 `WebSocket`；普通会话拥有独立端口、临时用户目录、标记页和 20 分钟空闲看门狗；明确授权的发布任务可选择持久专用会话。

## 硬规则

1. 不连接系统里已有的日常 Chrome/Edge。普通会话使用随机端口、独立临时 profile；明确授权的发布/运营任务可用 --persistent，默认专用端口 9337（SODUWORK_PUBLISH_BROWSER_PORT 可配置，0 自动分配）。两种模式都核对归属标记；端口占用时拒绝接管或关闭其他浏览器。
2. 普通工作流复用同一个 --session，不同任务使用不同 ID，结束后 close。用户明确要求记住登录态的发布任务使用 --persistent 和用户/空间隔离的稳定 ID，跨任务复用；窗口保留，不运行临时会话清理。显式 close --persistent 仅关闭本会话，不删除 profile；并发启动有锁。
3. 导航只接受 `http`、`https`、`file` 和 `about:blank`，拒绝带账号密码的 URL；导航失败、CDP 断开、元素不存在或不可编辑都会返回非零退出码。
4. 不替用户登录或保存凭据，除非当前请求明确授权；不把凭据写入参数、日志、截图。不要点删除、下单、发布等不可逆按钮，除非请求正文明确要求。

## 快速参考

```bash
S=skills/browser-use/scripts/browser.mjs
node $S shot https://example.com out.png --session task-123
node $S text current --session task-123
node $S errors current --session task-123
node $S do current '[{"click":"#open"},{"wait":300},{"shot":"after.png"},{"text":true}]' --session task-123
node $S status --session task-123
node $S close --session task-123
```

`do` 支持 `goto`、`click`、`fill`、`upload`（输入框、文本域和 contenteditable）、`wait`、`eval`、`shot`、`text`，一次最多 50 步；单步等待最多 30 秒、总等待最多 2 分钟。动作在连接浏览器前先校验，避免无效 JSON 启动会话。点击会自动滚动到可见区域并拒绝隐藏、禁用元素；截图会自动创建父目录。

## 验证与交付

先用 `text` 或 `shot`确认页面和目标，再执行点击/填写；关键动作前后各留一张截图。用 `errors` 检查控制台，用 `status`确认会话仍在运行，完成后关闭会话。把页面文字、截图路径和实际结果交回，不要只说“已操作”。


## 自动发布专用浏览器

仅用户明确要求实际发布、保存登录态或复用该发布会话采集时启用；普通浏览保持临时隔离。使用可见窗口供用户登录/验证码，不能绕过人工验证。profile 位于当前操作系统用户的 SoduWork/publishing-browser 目录，不能复制到工程、日志或插件包。

```bash
node "$S" tabs current --persistent --session publishing-<user-workspace-hash>
node "$S" open-tab https://example.com/publish --persistent --session publishing-<user-workspace-hash>
node "$S" text current --tab <targetId> --persistent --session publishing-<user-workspace-hash>
node "$S" do current '[{"upload":{"sel":"input[type=file]","files":["C:/absolute/document.pdf"]}}]' --tab <targetId> --persistent --session publishing-<user-workspace-hash>
```

先 tabs 检查已有页，每个选定网站复用一个标签页；open-tab 返回 targetId，后续 --tab 只接受此受管浏览器内的标签页。upload 只接受 1..30 个已存在的本地绝对文件路径；先读取实际页面定位输入框，不猜选择器。普通 close 不影响持久会话；需要关闭时加 --persistent，登录态仍保留。测试可加 --headless；业务发布默认可见，等待人工时不能关闭。环境变量 SODUWORK_PUBLISH_BROWSER_ROOT 仅供隔离测试或管理员设定专用数据目录，不能指向日常浏览器 profile。
