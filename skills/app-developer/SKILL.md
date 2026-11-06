---
name: app-developer
description: Build SoduWork apps and skills.
---

# 即用开发

目标：精致简洁、打开即用。英文 App，ID稳定。

边界：宿主提供通用能力；群组、成员关系、归组等业务由具体即用实现。

界面：中英文、一个契合业务的主题，不强制明暗双模式。

产品：意图→AI→成果；只收必要输入，AI起草/归类/标签，复制/搜索/游戏直接执行。不以大量表单＋“AI帮写”冒充AI产品。

执行 [development-workflow.md](references/development-workflow.md)：设计→实现→检查→安装打开→写回→重开/升版；缺证据不报通过。

- 设计：[design-quality.md](references/design-quality.md)；GitHub调研/许可；视觉调研可选，查最新同类。
- 单个图标：[icon-design.md](references/icon-design.md)；单色或彩色图标；透明/白/纯色底，禁多色及紫色渐变，渐变仅同色系明暗；顶层 icon=PNG≤256px/96KB。
- 五类：[instant-types.md](references/instant-types.md)；持续角色：[robot-persona.md](references/robot-persona.md)。入口用业务词语，真实执行后拟人表达；关窗计划仍运行。
- 账号/组织/对话/通知/本机及云资料：[host-data-sdk.md](references/host-data-sdk.md)；先声明能力，再调用真实SDK，分页读全，不编造接口。
- SDK/参数/鉴权/数据/MCP：[host-sdk.md](references/host-sdk.md)；复制同源SDK，读sdk/README.md；无顶层connect；宿主错误不伪装预览。
- 本地文件/导入/上传：[local-files.md](references/local-files.md)；原生桥选文件→会话；临时引用、持久素材、业务上传分开。
- 包/双语/交付：[bridge-and-delivery.md](references/bridge-and-delivery.md)；普通规范：plugin-development.md。
- package优先，复用宿主；本地结构：[local-app-structure.md](references/local-app-structure.md)；Web/H5不限栈。
- 技能与页面联动：[intelligent-interaction.md](references/intelligent-interaction.md)；写回/应用/追踪并验收。小任务ai.generate，复杂工作chat.send；见[fast-ai.md](references/fast-ai.md)。
- author真实；appCategory=office/game/robot/other；WEB/H5为接入方式。extensions保留未知字段、不放秘密。
- 数据遵从必选模式；[契约与JSON](references/cloud-data.md)。初始化版本化，不覆盖用户记录。
- 修改先读源码与 baseline.json；保留 key，提升 SemVer；资源完整收集，禁止省略未改文件。
- 最终磁盘运行 scripts/validate.cjs；失败修复重检。登记 .soduwork/delivery.json；走当前会话检查安装。静态检查不等于运行验收，不能虚构通过。
