# 单次 AI：界面内直接得到结果

适合：脑暴、改写、提词、分类、摘要。`soduWorkApp.ai.generate` 只发送本次技能提示词和输入；不创建对话、不读历史/工作区、不规划、不调用工具。需要资料/工具/任务执行时用 `chat.send`，不要让用户逐步管理内部字段。

声明：入口 `source.bridge.capabilities` 包含 `ai.generate`；复制当前同源 SDK 1.6。无需 `conversation.send` 或展开对话栏。

```js
// 从本即用随包的 ui/skills.js 导入；只发送本次需要的技能，勿塞整本手册。
import { brainstorm } from './skills.js';
const requestId = soduWorkApp.createRequestId(); // 一次用户动作一个编号，重复点击锁定按钮
const result = await soduWorkApp.ai.generate({
  input: userInput,
  instructions: brainstorm,
  maxOutputTokens: 256,
  requestId
});
if (!result.ok) { showError(result.reason); return; }
renderWords(result.text); // 模型文字按文本渲染；勿直接 innerHTML
// 需要保存时由即用明确 data.batch 写回并读回；单次AI不自动写库。
```

`ui/skills.js`：`export const brainstorm = '围绕用户的词脑暴5个有新意的词。只输出词语，中文顿号分隔。';`；它与UI一起完整随包，登记为 `kind:ui`，不是虚构的注册技能名。

| 参数 | 约束 |
| --- | --- |
| input / instructions | 必填字符串，各1–16000字；只传明确所需的业务素材；不自动读宿主数据 |
| model | 可选宿主允许的文字模型名称；缺省沿用宿主选择；不传密钥、地址或供应商配置 |
| maxOutputTokens | 默认256，1–2048，受模型上限约束；短结果优先小上限 |
| timeoutMs | 默认30000，1000–60000毫秒；包含模型/额度校验 |
| requestId | SDK可生成；建议显式保留，1–100个字母/数字/`_.:-` |

成功：`{ok:true,requestId,text,model,usage:{inputTokens?,outputTokens?,totalTokens?},finishReason:'stop'|'length'}`；额度/模型错误为 `{ok:false,code,reason}`；`uncertain:true` 表示请求已发出但结果未确认。`length` 提示结果可能被截断，不伪装完整结果。

宿主代理负责鉴权、可用模型及用量记账；仍消耗真实模型额度。没有上下文准备开销不等于模型必定瞬时回答；需低延迟时选择可用的快速文字模型。可控思考按宿主已有映射关闭额外思考；始终思考的模型不强行关闭或偷偷替换。

同一原生页面、账号及请求编号复用回执；内容变化须新编号。超时/断网不自动重试，尤其禁止换编号循环重发；重新打开页面后回执不保留。每即用最多2个、每账号最多4个并发；本页保留128条回执，满后明确提示重开，不静默淘汰造成重复计费。

验收：真实原生窗口点一次→结果在界面出现→请求中只有本次两段文字→没有新聊天；测重复点击、额度不足、模型失败、超时、切号和关闭。隔离假模型只能证明桥接与契约，不能宣称真实供应商速度或质量通过。
