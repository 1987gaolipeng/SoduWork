(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };

  // mobile:runtime-metadata
  var require_runtime_metadata = __commonJS({
    "mobile:runtime-metadata"(exports, module) {
      var rows = [{ "id": "pi", "displayName": "Pi", "summary": "\u4F4E\u5EF6\u8FDF\u529E\u516C\u4E0E\u8FDE\u7EED\u5BF9\u8BDD\uFF0C\u539F\u751F\u652F\u6301\u76EE\u6807\u6267\u884C", "transport": "direct", "modelMode": "managed", "goalMode": "native", "group": "recommended", "order": 10, "accessControl": { "schema": "soduwork.access-policy/v1", "supported": true, "modes": ["standard", "readonly", "full"], "approval": "tool-hook", "sandbox": false } }, { "id": "codex-harness", "displayName": "Codex Harness", "summary": "\u6DF1\u5EA6\u5DE5\u7A0B\u4E0E\u5B8C\u6574\u4EA4\u4ED8\uFF0C\u4F7F\u7528\u4F01\u4E1A\u6A21\u578B\u6301\u7EED\u6267\u884C", "transport": "runner", "modelMode": "managed", "goalMode": "native", "group": "recommended", "order": 20, "accessControl": { "schema": "soduwork.access-policy/v1", "supported": true, "modes": ["standard", "readonly", "full"], "approval": "native-acp", "sandbox": false } }, { "id": "opencode", "displayName": "OpenCode", "summary": "\u5F00\u653E\u5DE5\u7A0B Agent\uFF0C\u4F7F\u7528\u4F01\u4E1A\u6A21\u578B\u6267\u884C\u4EE3\u7801\u4E0E\u547D\u4EE4", "transport": "runner", "modelMode": "managed", "goalMode": "native", "group": "more", "order": 30, "accessControl": { "schema": "soduwork.access-policy/v1", "supported": true, "modes": ["standard", "readonly", "full"], "approval": "native-acp", "sandbox": false } }, { "id": "codex", "displayName": "Codex", "summary": "\u4F7F\u7528\u672C\u673A Codex \u8D26\u53F7\uFF0C\u4FDD\u7559\u539F\u751F\u89C4\u5212\u4E0E\u6267\u884C\u80FD\u529B", "transport": "runner", "modelMode": "account", "goalMode": "native", "group": "more", "order": 50, "accessControl": { "schema": "soduwork.access-policy/v1", "supported": true, "modes": ["standard", "readonly", "full"], "approval": "native-acp", "sandbox": false } }, { "id": "qwen", "displayName": "Qwen Code", "summary": "\u901A\u8FC7 ACP \u63A5\u5165\uFF0C\u4F7F\u7528\u4F01\u4E1A\u6A21\u578B\u5B8C\u6210\u81EA\u4E3B\u6267\u884C", "transport": "runner", "modelMode": "managed", "goalMode": "native", "group": "more", "order": 60, "accessControl": { "schema": "soduwork.access-policy/v1", "supported": true, "modes": ["standard", "readonly", "full"], "approval": "native-acp", "sandbox": false } }, { "id": "dsh", "displayName": "DeepSeek Harness", "summary": "\u8F7B\u91CF Harness\uFF0C\u4F7F\u7528\u4F01\u4E1A\u6A21\u578B\u5B8C\u6210\u6301\u7EED\u6267\u884C", "transport": "runner", "modelMode": "managed", "goalMode": "native", "group": "more", "order": 70, "accessControl": { "schema": "soduwork.access-policy/v1", "supported": true, "modes": ["standard", "readonly", "full"], "approval": "native-acp", "sandbox": false } }, { "id": "harness2", "displayName": "Google Harness\xB2", "summary": "\u901A\u8FC7 OpenCode \u76F4\u63A5\u6267\u884C\uFF1BGoogle Research \u63A8\u6F14\u6838\u5FC3\u7528\u4E8E\u663E\u5F0F\u8BCA\u65AD", "transport": "runner", "modelMode": "managed", "goalMode": "native", "group": "more", "order": 80, "accessControl": { "schema": "soduwork.access-policy/v1", "supported": true, "modes": ["standard", "readonly", "full"], "approval": "native-acp", "sandbox": false } }];
      module.exports = { runtime: (id) => rows.find((row) => row.id === id) || null };
    }
  });

  // client/main/conversation/agent-source.cjs
  var require_agent_source = __commonJS({
    "client/main/conversation/agent-source.cjs"(exports, module) {
      "use strict";
      var catalog = require_runtime_metadata();
      function normalize(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        if (typeof value.agentId !== "string" || !catalog.runtime(value.agentId)) return null;
        const result = { agentId: value.agentId };
        for (const [key, limit] of [["nodeKey", 120], ["nodeName", 160], ["runId", 120]]) {
          if (typeof value[key] !== "string") continue;
          const text = value[key].replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, limit);
          if (text) result[key] = text;
        }
        return Object.freeze(result);
      }
      function fields(value) {
        const sourceAgent = normalize(value);
        return sourceAgent ? { sourceAgent } : {};
      }
      function same(left, right) {
        const a = normalize(left), b = normalize(right);
        if (!a || !b) return !a && !b;
        return ["agentId", "runId", "nodeKey"].every((key) => (a[key] || "") === (b[key] || ""));
      }
      module.exports = { normalize, fields, same };
    }
  });

  // client/main/pi-session/tool-preparation.js
  var require_tool_preparation = __commonJS({
    "client/main/pi-session/tool-preparation.js"(exports, module) {
      "use strict";
      var pending = /* @__PURE__ */ new WeakMap();
      var agentSource = require_agent_source();
      var operations = /^(read|read_file|readfile|write|write_file|writefile|create_file|edit|edit_file|editfile|delete|delete_file|deletefile|remove_file)$/i;
      function shortCall(call) {
        if (!call || typeof call !== "object") return null;
        const id = String(call.id || call.callId || "").slice(0, 500);
        const name = String(call.name || call.tool || "").slice(0, 100);
        const args = call.arguments || call.args || {};
        const path = ["path", "filePath", "file_path", "filename", "file", "target"].map((key) => args[key]).find((value) => typeof value === "string" && value.trim());
        if (!id || !operations.test(name)) return null;
        return { id, name, arguments: path ? { path: path.slice(0, 1500) } : {} };
      }
      function put(state, call, sourceAgent) {
        const brief = shortCall(call);
        if (!brief || (state.tools || []).some((tool) => tool.id === brief.id || tool.callId === brief.id)) return null;
        let rows = pending.get(state);
        if (!rows) {
          rows = /* @__PURE__ */ new Map();
          pending.set(state, rows);
        }
        const previous = rows.get(brief.id);
        const row = {
          id: brief.id,
          name: brief.name,
          args: brief.arguments,
          ...agentSource.fields(sourceAgent || call.sourceAgent || previous?.sourceAgent),
          phase: "preparing",
          state: "running",
          after: Math.max(0, state.messages.length - 1),
          scope: state.currentScope || "normal",
          ...previous ? { after: previous.after } : {}
        };
        rows.set(row.id, row);
        return brief;
      }
      function take(state, id) {
        const rows = pending.get(state), row = rows?.get(String(id || ""));
        rows?.delete(String(id || ""));
        return row;
      }
      function clear(state) {
        pending.delete(state);
      }
      function finishTask(state, value) {
        if (!/^(completed|done|failed|stopped|cancelled|canceled|error)$/.test(value.status || "")) return;
        const prefix = "task:" + value.taskId + ":";
        for (const id of pending.get(state)?.keys() || []) if (id.startsWith(prefix)) take(state, id);
      }
      function list(state) {
        return Array.from(pending.get(state)?.values() || [], (row) => ({ ...row, args: { ...row.args } }));
      }
      function observe(state, event) {
        if (/^tool_execution_(start|update|end)$/.test(event.type)) take(state, event.toolCallId);
        else if (["agent_start", "agent_settled", "auto_retry_start"].includes(event.type) || event.type === "message_end" && ["error", "aborted", "length"].includes(event.message?.stopReason)) clear(state);
      }
      function runtime(state, item) {
        if (item.kind !== "tool-preparing") return false;
        if (item.phase === "cancelled") take(state, item.callId);
        else put(state, { id: item.callId, name: item.tool, arguments: item.arguments }, item.sourceAgent);
        return true;
      }
      module.exports = { shortCall, put, take, clear, finishTask, list, observe, runtime };
    }
  });

  // client/main/conversation/message-time.js
  var require_message_time = __commonJS({
    "client/main/conversation/message-time.js"(exports, module) {
      "use strict";
      function epoch(value) {
        const number = typeof value === "number" ? value : typeof value === "string" && /^\d{4}-\d{2}-\d{2}[T ]/.test(value) ? Date.parse(value) : 0;
        return Number.isFinite(number) && number > 0 && number <= 864e13 ? number : 0;
      }
      function stampPiEvent(event, sentAt, submissionId) {
        if (event?.type !== "message_end" || event.replay) return event;
        const message = event.message;
        if (!message || typeof message !== "object") return event;
        if (message.role === "user") {
          message.sentAt = epoch(message.sentAt) || epoch(sentAt) || epoch(message.timestamp) || Date.now();
          const id = String(submissionId || "").trim();
          if (id) message.submissionId = id.slice(0, 128);
        } else if (message.role === "assistant") {
          message.completedAt = epoch(message.completedAt) || Date.now();
        }
        return event;
      }
      function storedMessage(entry) {
        const message = entry?.message;
        if (!message || typeof message !== "object") return null;
        if (message.role === "user") return {
          ...message,
          sentAt: epoch(message.sentAt) || epoch(message.timestamp) || epoch(entry.timestamp)
        };
        if (message.role === "assistant") return {
          ...message,
          completedAt: epoch(message.completedAt) || epoch(entry.timestamp)
        };
        return message;
      }
      module.exports = { epoch, stampPiEvent, storedMessage };
    }
  });

  // client/main/agent-runtime/assistant-text.cjs
  var require_assistant_text = __commonJS({
    "client/main/agent-runtime/assistant-text.cjs"(exports, module) {
      "use strict";
      var CODEX_MODEL_WARNING = /^Warning: Model metadata for `[^`]+` not found\. Defaulting to fallback metadata; this can degrade performance and cause issues\.\s*/i;
      var WARNING_HEAD = "Warning: Model metadata for `";
      var WARNING_TAIL = "` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.";
      function cleanStream(value, final = false) {
        const text = String(value || "");
        const trimmed = text.trimStart();
        if (CODEX_MODEL_WARNING.test(trimmed)) return trimmed.replace(CODEX_MODEL_WARNING, "");
        if (!final) {
          const head = WARNING_HEAD.toLowerCase(), candidate = trimmed.toLowerCase();
          if (head.startsWith(candidate)) return "";
          if (candidate.startsWith(head)) {
            const rest = candidate.slice(head.length), end = rest.indexOf("`");
            if (end < 0 && !/[\r\n]/.test(rest)) return "";
            if (end > 0 && WARNING_TAIL.toLowerCase().startsWith(rest.slice(end))) return "";
          }
        }
        return text;
      }
      function clean(value) {
        return cleanStream(value, true).trim();
      }
      module.exports = { clean, cleanStream };
    }
  });

  // client/main/agent-runtime/runner-messages.js
  var require_runner_messages = __commonJS({
    "client/main/agent-runtime/runner-messages.js"(exports, module) {
      "use strict";
      var preparation = require_tool_preparation();
      var { epoch } = require_message_time();
      var source = require_agent_source();
      function create(state, redact = (value) => value) {
        const streams = /* @__PURE__ */ new Map();
        const rawStreams = /* @__PURE__ */ new Map();
        const pendingPositions = /* @__PURE__ */ new Map();
        const filterDiagnostics = ["codex", "codex-harness"].includes(state.adapterId);
        function finish(completedAt) {
          preparation.clear(state);
          let inserted = 0;
          for (const [key, pending] of pendingPositions) {
            const text = require_assistant_text().cleanStream(rawStreams.get(key), true);
            if (!text.trim()) continue;
            const message = {
              role: "assistant",
              ...source.fields({ agentId: state.adapterId }),
              blocks: [{ kind: pending.kind, text: redact(text) }],
              done: false
            };
            state.messages.splice(pending.position + inserted++, 0, message);
            streams.set(key, message);
          }
          pendingPositions.clear();
          for (const message of streams.values()) {
            message.done = true;
            for (const block of message.blocks) block.done = true;
            if (!message.completedAt && epoch(completedAt)) message.completedAt = epoch(completedAt);
          }
          streams.clear();
          rawStreams.clear();
        }
        function apply(item, text) {
          item = { ...item, ...source.fields({ agentId: state.adapterId }) };
          if (preparation.runtime(state, item)) return true;
          if (item.kind === "thinking" || item.kind === "text" || item.kind === "say" && (item.delta || item.streamId)) {
            const key = [
              item.round || item._round || state.round || 1,
              item.seg || 1,
              item.kind,
              item.streamId || item.seq
            ].join(":");
            if (filterDiagnostics) {
              const previous = rawStreams.get(key) || "";
              const raw2 = (text || !item.done || item.delta ? item.delta ? previous + text : text : previous).slice(-5e4);
              rawStreams.set(key, raw2);
              text = require_assistant_text().cleanStream(raw2, item.done === true);
            }
            let message2 = streams.get(key);
            if (!message2) {
              if (!text) {
                if (filterDiagnostics && !pendingPositions.has(key)) pendingPositions.set(key, {
                  position: state.messages.length,
                  kind: item.kind === "thinking" ? "thinking" : "text"
                });
                return true;
              }
              pendingPositions.delete(key);
              message2 = { role: "assistant", ...source.fields(item.sourceAgent), blocks: [{ kind: item.kind === "thinking" ? "thinking" : "text", text: "" }], done: false };
              state.messages.push(message2);
              streams.set(key, message2);
            }
            const block = message2.blocks[0];
            if (text || !item.done || item.delta) {
              block.text = String(redact(item.delta && !filterDiagnostics ? block.text + text : text)).slice(-5e4);
            }
            message2.done = item.done === true;
            block.done = message2.done;
            if (message2.done && !message2.completedAt) message2.completedAt = epoch(item.completedAt) || epoch(item.at);
            return true;
          }
          if (item.kind !== "usage") return false;
          const raw = item.usage;
          if (!raw || !["step", "message", "turn"].includes(item.usageScope)) return true;
          const count = (key) => Number.isFinite(raw[key]) && raw[key] >= 0 ? Math.floor(raw[key]) : 0;
          const input = count("input"), output = Math.max(count("output"), count("reasoning"));
          if (!input && !output) return true;
          const covered = [];
          for (let i = state.messages.length - 1; i >= 0 && state.messages[i].role !== "user"; i--) {
            const row = state.messages[i];
            if (row.role !== "assistant") continue;
            if (item.usageScope !== "turn" && row.usage) break;
            covered.unshift(row);
          }
          for (const row of covered) {
            row.usage = { input: 0, output: 0, totalTokens: 0, inputIncludesCache: true };
            row.done = true;
            for (const block of row.blocks || []) block.done = true;
            if (!row.completedAt) row.completedAt = epoch(item.at);
          }
          let message = covered.at(-1);
          if (!message) {
            message = { role: "assistant", ...source.fields(item.sourceAgent), blocks: [], done: true, completedAt: epoch(item.at) };
            state.messages.push(message);
          }
          message.usage = {
            input,
            output,
            cacheRead: count("cacheRead"),
            cacheWrite: count("cacheWrite"),
            reasoning: count("reasoning"),
            inputIncludesCache: true,
            totalTokens: input + output
          };
          state.usageRevision = Number(state.usageRevision || 0) + 1;
          return true;
        }
        function argumentsOf(item, fallback) {
          const source2 = item.arguments && typeof item.arguments === "object" ? item.arguments : null;
          if (!source2) return { command: fallback };
          const args = {};
          for (const key of ["path", "filePath", "file_path", "command", "pattern", "query"]) {
            if (typeof source2[key] === "string") args[key] = redact(source2[key].slice(0, 1500));
          }
          return args;
        }
        return { apply, finish, argumentsOf, takePreparation: (item) => preparation.take(state, item.callId) };
      }
      module.exports = { create };
    }
  });

  // <stdin>
  window.SoduWorkRunnerMessages = require_runner_messages();
})();

window.SoduWorkPluginAuthoringContract = "新创作与改进的应用/插件最低支持中英双语；先读随包 references/plugin-locales.md，按 locales 配置翻译并验证回退。\nSoduWork 内置 soduwork-media 生成图片/视频。图片插件在 mcpServers 声明 soduwork-media，调用 generate_image（prompt，可选 model、providerId、size、filename）。视频先脚本与分镜再 generate_video。每次生成唯一 generationId，同次重试不变，避免重复扣费。模型与密钥沿用「我的模型」，不索要或保存，不另配外部 MCP；展示真实返回文件。\n你是 SoduWork 插件开发助手。先理解用户希望沉淀的工作方法、输入、步骤、工具、完成标准和风险。\n优先直接形成完整方案；只有缺少会改变结果的关键信息时才询问。\n最终在工作目录生成 soduwork-plugin-draft.json，字段必须包含 template、name、version、description、instructions、inputs、setup、mcpServers、runtimeCapabilities、evaluationInstruction、evaluationCriteria。\n用户提供 REST 接口清单时，优先使用 mcp-studio 的 scripts/mcp-config.cjs api 编译为 soduwork-api 声明式连接器，按其报告带入认证字段；不为每个系统生成并执行新程序。OpenAPI 3.0/3.1 JSON/YAML 可从现有导入配置入口直接导入。\n制作外部 MCP 连接插件时，先从官方文档确认真实服务地址、接入方式和权限；不能编造服务或宣称尚未授权的连接已经可用。\n除已有 platforms 账号连接和 soduwork-media 外，为 mcpServers 中每个需要新建的 HTTP/可信本地连接实际生成 references/connections/<连接名>.mcp.json，并在草稿 resources 声明 {\"path\":\"references/connections/<连接名>.mcp.json\",\"kind\":\"reference\"}。连接名必须与 mcpServers 中该项完全一致。\n每个模板使用 {\"mcpServers\":{\"<连接名>\":{\"type\":\"http\",\"url\":\"<官方业务 MCP 地址>\",\"headers\":{\"Authorization\":\"\"},\"enabled\":false}}} 结构，只含这一个连接。不要原样保留示例占位地址；URL、鉴权头名称应来自真实官方契约，所有 headers/env 值必须为空。可声明实际支持的 enabledTools、disabledTools 与超时，不写虚构工具名。\n模板不能携带密码、Token、个人OAuth绑定、动态鉴权辅助器、宿主环境变量引用或含凭据 URL；REST API 模板可声明受支持的 OAuth2 授权码PKCE或Client Credentials，凭据在配置页填写；不支持的私有鉴权只交付接入说明，不用空 Token 冒充授权。个人 stdio 只允许现有可信模板，自定义命令交管理员审查，不在导入时安装或执行。\n安装后点击试用会读取此插件当前版本的模板并打开连接预览；用户核对后导入为停用，再在预填的连接页填写凭据、测试和启用。不要求用户复制 URL 或鉴权字段，不修改已有同名连接。静态预检通过不等于真实连接或业务验证通过。\n凡需在会话工作区写入报告、方案或脚本文件，应在 runtimeCapabilities 显式声明 files；不要把 MCP 的只读业务权限与本地文件输出权限混为一谈。\n已有 platforms 连接在模型启动前校验，未授权时插件不能开始；不要承诺未连接仍由同一插件自动生成草稿。可以提示用户先授权，或取消插件后在普通对话起草；运行中读取失败则明确缺失范围。\nsoduwork-media 当前公开 generate_image 与 generate_video，视频提交和等待在工具内部完成；只按真实工具返回说明结果，不虚构独立轮询或任务查询工具。同参数失败重试可沿用 generationId，修改请求必须使用新 ID，不能承诺平台不重复扣费。\ninputs 是任务或自动化启动时填写的公开参数，只允许 text、textarea、boolean、number、select；不得收集账号、密码、Token 或密钥。\ninputs 的 select.options 支持字符串或 {value,label} 对象；default 必须精确等于某个 options 的 value（字符串选项则等于字符串本身），不能填 label 或删去 value 中的“（默认）”后缀。默认标记应只写在 label 中，value 保持稳定。\n公开参数示例：{\"key\":\"run_mode\",\"label\":\"运行模式\",\"type\":\"select\",\"options\":[{\"value\":\"confirm\",\"label\":\"每步人工确认（默认）\"},{\"value\":\"auto\",\"label\":\"自动执行\"}],\"default\":\"confirm\"}\n交付前必须从磁盘重读最终插件草稿（每次修复后也重读），逐项检查 inputs 的类型与 default、options 的 value 一致，检查 setup 和资源。自检失败先修复并重新检查，通过后才登记交付清单并提示检查安装；文件另存时把清单指向最终新稿，不保留旧稿为主成果。自检不是平台安装预检，不能据此声称已安装或发布。\nsetup 是安装到企业后每位同事只需填写一次的非敏感使用偏好；支持 text、textarea、boolean、number、select、multiselect、url。账号、密码、Token、OAuth 和密钥必须使用企业连接，不能放进 setup。\nsetup 必须采用对象格式：{\"title\":\"使用偏好\",\"description\":\"安装后配置一次\",\"preferences\":[{\"key\":\"language\",\"label\":\"语言\",\"type\":\"select\",\"options\":[\"中文\",\"英文\"],\"default\":\"中文\"}]}。没有偏好时使用 {\"preferences\":[]}；不要把 setup 写成数组、文字说明或安装命令。每项使用 key、label、type，select/multiselect 必须有 options，default 必须匹配类型和选项。交付前读取实际生成的 JSON，核对 setup.preferences、必填字段和所有资源文件。\n同时创建 .soduwork/delivery.json，严格采用下方 schemaVersion=1 和 deliverables 数组格式；不要使用顶层 primary 或 items 对象。只登记可安装草稿为主成果。\ntemplate只能是method/connector/workflow/app；version用SemVer，禁止真实凭据。app须ui.contributions的workspace.navigation：external用真实HTTP(S)url；纯静态H5用source.type=package、entry=ui/index.html，依赖列入resources(ui/asset)，壳直接打开，无需服务或ukey。\n平台连接器也直接在 SoduWork 客户端制作。需要飞书、企业微信或钉钉时，声明 platforms 数组（feishu、wecom、dingtalk，可组合）；插件名称与 key 按业务命名，不必使用平台名称。SoduWork 自动复用当前用户的平台账号连接，安装后先连接再试用。飞书会补齐 feishu MCP；CLI 平台会注入固定运行参数。其他系统使用已配置 MCP，或声明 terminal 并随包提供真实 CLI 脚本，不能编造 MCP 名称来通过预检。\n完成后让用户点击本次回复旁的“检查并安装”，SoduWork 将收集当前会话的完整资源并安装；不要要求用户自己打开隐藏目录、复制 JSON 或改源码。账号未连接时使用客户端授权入口，不能把结构检查通过写成真实业务已经成功。\n当 template=workflow 时，增加 workflow.nodes。每个节点写清 key、type、name、dependsOn、outputs 和 config；输入由直接上游的声明产出自动交接。\n默认生成可以直接在本机运行的个人工作流。只有用户明确要求企业项目研发或部署时，才使用 spec、quality、approval、merge、deploy_chain、validate 企业节点，并说明企业审核和项目绑定要求；quality 使用 commands 中的 argv 数组，部署由企业环境中心管理，不写服务器地址或凭据。\n“研发实现”和“最终上线”可以制作成两个独立插件：研发插件交付并合并固定提交；上线插件从同一项目任务的已合并代码版本开始，使用 deploy_chain → validate → publish。两个插件分别安装、审核、绑定和升级，不能把另一个插件的内容复制成伪组合。\n插件需要模板、示例、图片或脚本时，必须实际生成这些文件，放在草稿旁的 templates、examples、assets、scripts、references 或 ui 子目录。草稿 resources 数组逐项声明 path 和 kind（template/example/asset/script/reference/ui）；不要只输出一个没有资源的 JSON。安装时 SoduWork 会从当前会话收集这些文件并锁定校验值。\n真实调用模板/脚本并验证交付物后登记草稿；单Agent试用不代表多节点调试。HTML保存为ui资源，external须可用服务。应用优先使用即用开发技能。\n草稿顶层 mcpServers、runtimeCapabilities、skills 必须是字符串数组。写本地文件用 runtimeCapabilities:[\"files\"]，需要终端才追加 \"terminal\"；无连接器/额外技能分别用 mcpServers:[]、skills:[]。不能写 runtimeCapabilities:{\"files\":true} 或 mcpServers:{}。随包 .mcp.json 内的 mcpServers 配置对象不是草稿字段；草稿只填写连接器名称，不复制连接配置。随包参考文件写 resources，不把文件名或自创技能名放进 skills。\n多底座协调必须使用 template=workflow，不能只在 instructions 中描述多个 Agent 或编造 agent/multi_agent 节点。\n个人本机协作节点仅使用 ai、ai_review、human_review、publish；spec、quality、approval、merge、deploy_chain、validate 是企业执行节点，安装后须经企业审核并绑定项目，不能用于直接本机试用。\n每个 AI 节点在 config.agentKind 中填写实际路由：Pi=local:pi；Codex Harness=local:codex-harness；OpenCode=local:opencode；Codex=local:codex；Qwen Code=local:qwen；DeepSeek Harness=local:dsh；Google Harness²=local:harness2。Qwen Code 的标识是 local:qwen，不能写 local:qwen-code。省略 agentKind 才表示沿用当前底座；用户明确指定底座时保留该选择。\n本机协作不要填写 runnerTags、Runner ID 或机器地址。没有用户指定且可核对的模型 ID 时省略 config.model，各底座读取自己的可用模型；不能根据底座名称猜测模型 ID，也不能把 Pi 的模型名复制给 Qwen Code。无法安装或未授权的底座应报告缺项，不能偷偷改用另一个 Agent。\nAI 节点的 config.prompt 为本节点工作说明；dependsOn 引用直接上游节点 key。outputs 每项必须含 key、kind，file/decision 还须含相对当前节点目录的 path。路径不能是上游节点目录或绝对地址；平台按 inputs.fromNode/outputKey 校验并复制上游材料，不同底座无需共享工作目录。\n节点 inputs 只能填写 key、fromNode、outputKey、label（可选）、required（布尔，可选），不能填写 path、absolutePath 或自定复制目标。文件交接时平台在本节点 .soduwork-inputs 内分配带哈希的实际路径；节点 prompt 必须要求按“上游已校验材料”清单的 inputKey 找到对应记录，再按其实际 path/absolutePath 读取，不得猜 input/plan.md 等固定落点，也不访问上游工作目录。\n每个 inputs[].fromNode 必须直接出现在当前节点 dependsOn 数组中，此规则包括 human_review；间接依赖不算。例：review 依赖 draft，accept 同时验收 draft 和 review 的产出时，accept.dependsOn 必须是 [\"draft\",\"review\"]，不能只写 [\"review\"]。每个 outputKey 还必须存在于对应 fromNode 的 outputs 中。交付前逐节点核对这些关系；平台预检报错时按缺失节点或字段修正草稿，不修改校验规则。自写的 JSON 检查脚本不等于平台安装预检。\n最小双底座流程示例（这是完整草稿；按用户需求修改名称、prompt、文件和评测）：{\"template\":\"workflow\",\"key\":\"pi-qwen-workflow\",\"name\":\"Pi 与 Qwen 协作\",\"version\":\"1.0.0\",\"description\":\"Pi 形成计划文件，Qwen 依据该计划交付结果，最后由用户验收\",\"instructions\":\"按各节点的指令和真实输入清单协作，文件交接由平台核验，等待人工验收后完成。\",\"inputs\":[],\"setup\":{\"preferences\":[]},\"skills\":[],\"mcpServers\":[],\"runtimeCapabilities\":[\"files\"],\"resources\":[],\"evaluationInstruction\":\"给出一个明确目标，核对两节点完成文件交接并等待人工验收。\",\"evaluationCriteria\":[\"Pi 生成 plan.md\",\"Qwen 读取平台交接的 plan.md 后生成 result.md\",\"未经人工验收不能完成\"],\"workflow\":{\"nodes\":[{\"key\":\"plan\",\"type\":\"ai\",\"name\":\"理解规划\",\"dependsOn\":[],\"inputs\":[],\"outputs\":[{\"key\":\"plan\",\"kind\":\"file\",\"path\":\"plan.md\",\"label\":\"执行计划\"}],\"config\":{\"agentKind\":\"local:pi\",\"prompt\":\"理解本次目标，将可执行计划写入当前节点目录的 plan.md。\"}},{\"key\":\"work\",\"type\":\"ai\",\"name\":\"实施交付\",\"dependsOn\":[\"plan\"],\"inputs\":[{\"key\":\"plan\",\"fromNode\":\"plan\",\"outputKey\":\"plan\",\"required\":true}],\"outputs\":[{\"key\":\"result\",\"kind\":\"file\",\"path\":\"result.md\",\"label\":\"交付文件\"}],\"config\":{\"agentKind\":\"local:qwen\",\"prompt\":\"从“上游已校验材料”清单找到 inputKey=plan 的记录，按其实际 path/absolutePath 读取计划，在本节点目录内完成并核对 result.md。不得猜测输入路径或修改输入副本。\"}},{\"key\":\"accept\",\"type\":\"human_review\",\"name\":\"人工验收\",\"dependsOn\":[\"plan\",\"work\"],\"inputs\":[{\"key\":\"plan\",\"fromNode\":\"plan\",\"outputKey\":\"plan\",\"required\":true},{\"key\":\"result\",\"fromNode\":\"work\",\"outputKey\":\"result\",\"required\":true}],\"outputs\":[],\"config\":{\"summary\":\"对照计划与交付文件验收本次结果\"}},{\"key\":\"complete\",\"type\":\"publish\",\"name\":\"完成\",\"dependsOn\":[\"accept\"],\"inputs\":[],\"outputs\":[],\"config\":{}}]}}\n交付清单示例（写入 .soduwork/delivery.json，与草稿分开；deliverables 是数组，primary 属于数组元素）：{\"schemaVersion\":1,\"summary\":\"插件草稿已生成，可检查并安装\",\"deliverables\":[{\"path\":\"soduwork-plugin-draft.json\",\"kind\":\"file\",\"title\":\"可安装插件草稿\",\"primary\":true}]}\n安装个人工作流后，在普通对话中选择该插件并发送，会真实逐节点调度所选底座，人工节点等待用户确认；也可使用 /调试插件 或“逐节点调试”检查。不要把整段工作流交给一个 Agent 模拟，或把本机协作办结说成已通过企业审批、上架。\nAI 审查节点应声明 decision 文件，JSON 使用企业协议：schemaVersion=1，outcome=proceed 或 blocked，summary、reasonCode、evidence 和 nextAction。未通过审查不能继续后续节点。\n即用窗口默认 1800×1125（16:10）并适配小屏；作者可声明顶层 appWindow 的 width/height/minWidth/minHeight/maxWidth/maxHeight 与响应规则，支持 px/vw/vh；不提供用户尺寸设置。\n【移动端交付补充】手机通过当前会话的授权成果读取 soduwork-plugin-draft.json。除实际资源文件外，草稿 resources 中也应包含对应文件的 encoding（utf8 或 base64）和真实 content，形成可移植草稿；不得只留本机路径。用户先检查表单，确认后提交企业隔离区审核，不能声称已在手机安装或发布。";
