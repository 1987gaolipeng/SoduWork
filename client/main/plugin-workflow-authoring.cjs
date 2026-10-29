'use strict';

const catalog = require('./agent-runtime/runtime-catalog');

// Share runtime identifiers with the execution directory so authoring does not invent routes from display names.
function instructions() {
  const routes = catalog.runtimes().map(row => row.displayName + '=local:' + row.id).join('；');
  return [
    '草稿顶层 mcpServers、runtimeCapabilities、skills 必须是字符串数组。写本地文件用 runtimeCapabilities:["files"]，需要终端才追加 "terminal"；无连接器/额外技能分别用 mcpServers:[]、skills:[]。不能写 runtimeCapabilities:{"files":true} 或 mcpServers:{}。随包 .mcp.json 内的 mcpServers 配置对象不是草稿字段；草稿只填写连接器名称，不复制连接配置。随包参考文件写 resources，不把文件名或自创技能名放进 skills。',
    '多底座协调必须使用 template=workflow，不能只在 instructions 中描述多个 Agent 或编造 agent/multi_agent 节点。',
    '个人本机协作节点仅使用 ai、ai_review、human_review、publish；spec、quality、approval、merge、deploy_chain、validate 是企业执行节点，安装后须经企业审核并绑定项目，不能用于直接本机试用。',
    '每个 AI 节点在 config.agentKind 中填写实际路由：' + routes + '。Qwen Code 的标识是 local:qwen，不能写 local:qwen-code。省略 agentKind 才表示沿用当前底座；用户明确指定底座时保留该选择。',
    '本机协作不要填写 runnerTags、Runner ID 或机器地址。没有用户指定且可核对的模型 ID 时省略 config.model，各底座读取自己的可用模型；不能根据底座名称猜测模型 ID，也不能把 Pi 的模型名复制给 Qwen Code。无法安装或未授权的底座应报告缺项，不能偷偷改用另一个 Agent。',
    'AI 节点的 config.prompt 为本节点工作说明；dependsOn 引用直接上游节点 key。outputs 每项必须含 key、kind，file/decision 还须含相对当前节点目录的 path。路径不能是上游节点目录或绝对地址；平台按 inputs.fromNode/outputKey 校验并复制上游材料，不同底座无需共享工作目录。',
    '节点 inputs 只能填写 key、fromNode、outputKey、label（可选）、required（布尔，可选），不能填写 path、absolutePath 或自定复制目标。文件交接时平台在本节点 .soduwork-inputs 内分配带哈希的实际路径；节点 prompt 必须要求按“上游已校验材料”清单的 inputKey 找到对应记录，再按其实际 path/absolutePath 读取，不得猜 input/plan.md 等固定落点，也不访问上游工作目录。',
    '每个 inputs[].fromNode 必须直接出现在当前节点 dependsOn 数组中，此规则包括 human_review；间接依赖不算。例：review 依赖 draft，accept 同时验收 draft 和 review 的产出时，accept.dependsOn 必须是 ["draft","review"]，不能只写 ["review"]。每个 outputKey 还必须存在于对应 fromNode 的 outputs 中。交付前逐节点核对这些关系；平台预检报错时按缺失节点或字段修正草稿，不修改校验规则。自写的 JSON 检查脚本不等于平台安装预检。',
    '最小双底座流程示例（这是完整草稿；按用户需求修改名称、prompt、文件和评测）：' + JSON.stringify({
      template: 'workflow', key: 'pi-qwen-workflow', name: 'Pi 与 Qwen 协作', version: '1.0.0',
      description: 'Pi 形成计划文件，Qwen 依据该计划交付结果，最后由用户验收',
      instructions: '按各节点的指令和真实输入清单协作，文件交接由平台核验，等待人工验收后完成。',
      inputs: [], setup: { preferences: [] }, skills: [], mcpServers: [], runtimeCapabilities: ['files'], resources: [],
      evaluationInstruction: '给出一个明确目标，核对两节点完成文件交接并等待人工验收。',
      evaluationCriteria: ['Pi 生成 plan.md', 'Qwen 读取平台交接的 plan.md 后生成 result.md', '未经人工验收不能完成'],
      workflow: { nodes: [
      { key: 'plan', type: 'ai', name: '理解规划', dependsOn: [], inputs: [],
        outputs: [{ key: 'plan', kind: 'file', path: 'plan.md', label: '执行计划' }],
        config: { agentKind: 'local:pi', prompt: '理解本次目标，将可执行计划写入当前节点目录的 plan.md。' } },
      { key: 'work', type: 'ai', name: '实施交付', dependsOn: ['plan'],
        inputs: [{ key: 'plan', fromNode: 'plan', outputKey: 'plan', required: true }],
        outputs: [{ key: 'result', kind: 'file', path: 'result.md', label: '交付文件' }],
        config: { agentKind: 'local:qwen', prompt: '从“上游已校验材料”清单找到 inputKey=plan 的记录，按其实际 path/absolutePath 读取计划，在本节点目录内完成并核对 result.md。不得猜测输入路径或修改输入副本。' } },
      { key: 'accept', type: 'human_review', name: '人工验收', dependsOn: ['plan', 'work'],
        inputs: [{ key: 'plan', fromNode: 'plan', outputKey: 'plan', required: true },
          { key: 'result', fromNode: 'work', outputKey: 'result', required: true }],
        outputs: [], config: { summary: '对照计划与交付文件验收本次结果' } },
      { key: 'complete', type: 'publish', name: '完成', dependsOn: ['accept'], inputs: [], outputs: [], config: {} },
    ] } }),
    '交付清单示例（写入 .soduwork/delivery.json，与草稿分开；deliverables 是数组，primary 属于数组元素）：' + JSON.stringify({
      schemaVersion: 1, summary: '插件草稿已生成，可检查并安装',
      deliverables: [{ path: 'soduwork-plugin-draft.json', kind: 'file', title: '可安装插件草稿', primary: true }],
    }),
    '安装个人工作流后，在普通对话中选择该插件并发送，会真实逐节点调度所选底座，人工节点等待用户确认；也可使用 /调试插件 或“逐节点调试”检查。不要把整段工作流交给一个 Agent 模拟，或把本机协作办结说成已通过企业审批、上架。',
  ].join('\n');
}

module.exports = { instructions };
