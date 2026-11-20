# SoduWork Hub（后端）

**简体中文** · [English](README.md) · [开发指南](../docs/development.md#hub-后端)

命令示例中的 `sh start.sh` 适用于 macOS/Linux；Windows PowerShell 使用 `.\start.cmd`，命令提示符使用 `start.cmd`，参数相同。独立 Python 工具示例使用 `python3`；Windows 使用 `py`，已激活虚拟环境时使用 `python`。

SoduWork 的任务与协作中枢，提供身份、权限、执行治理、插件、资料和客户端接入。
FastAPI + SQLAlchemy(async) + PostgreSQL（本地开发可回退 SQLite）。

模块职责与状态归属见[首版范围](../docs/release-scope.md)。

## 快速开始（本地 SQLite，零配置）

```bash
cd hub-backend
python3 -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # Windows
# source .venv/bin/activate && pip install -r requirements.txt   # *nix
# 如需覆盖配置，创建私有 .env；首次体验推荐根目录 sh start.sh
.venv/Scripts/python -m uvicorn app.main:app --reload --port 9080
```

打开 http://127.0.0.1:9080/docs 查看 API 文档，健康检查为 `GET /healthz`。

## 桌面本地 Runner 事件恢复

桌面本地 Runner 执行会将事件去向与会话别名分别持久化。本地历史不会进入 Hub
任务回传通道，Hub outbox 阻塞也不会阻止本地执行；CPU、内存和执行并发限制仍然生效。
桌面排队中的轮次显示排队文案，不再显示模型处理中的文案。

升级后，Runner 仅在旧聊天的别名、底座与确定性执行引用一致时确认其本地归属。
恢复时会持久化已确认的本地路由归属；无法确认的记录保留原有路由元数据。
确认属于本地的事件包会先写入私有 `local-events-*.archive` 恢复文件，再从活跃
outbox 移除；Windows 载荷保留 DPAPI 保护，采集标记保持不变。归属不明的事件流及
真实 Hub 事件均保持原状，NACK 不会被当成 ACK。恢复文件总量限制为配置的 outbox
字节预算的三倍，包含编码开销。归档失败时保留原事件并输出诊断；无关 Hub 事件的
投递与采集仍可继续，但受实际 outbox 容量限制。恢复文件应保持私有，在完成核查前保留。
运行 `python3 -m unittest test_runner_event_scope test_runner_event_delivery` 可验证
归属路由、重启恢复、归档写入中断和 Hub 事件保留。

## 受管 Pi 执行

受管 Pi 执行为每条 Runner 执行记录绑定独立的配置与会话目录，目录位于 Runner 数据根目录下。启动及后续轮次使用同一个明确路径，不依赖继承的桌面 Pi 设置或操作系统主目录解析。模型文件只保存凭据的环境变量引用；模型配置缺失或文件发布失败时，会在 Pi 启动前停止执行。个人 Pi 与桌面本地模型配置保持不变。升级时，只允许将 Runner 记录中明确标识且工作目录匹配的原生会话复制到私有目录，原文件保持不变。已有执行历史的后续轮次必须找到原生会话，不会静默新建会话。

Runner 重启后，恢复终端仍绑定原执行的会话历史，不恢复模型凭据，也不改写模型文件。新的受管执行轮次仍须单独获得模型授权。

安装客户端依赖后，可在后端测试环境运行 `python3 e2e_pi_dispatch_config.py --output /absolute/evidence/directory`，通过隔离鉴权 Hub、真实 Runner 和 Pi 子进程及本机回环模型验证派发、后续轮次、文件产物、重启后的原生终端恢复与个人模型配置保护。该验证不覆盖生产模型或原生桌面界面。

## Runner 多会话并发

桌面私有通道与 Hub RPC 分别为工作、读取、底座检测和控制保留有上限的处理能力。慢检测或历史读取不会占用停止其他会话所需的工作线程。同一执行引用的变更操作在两个通道间保持顺序；停止会使更早收到、但尚未进入持久化准入的请求失效。因通道容量拒绝的请求会明确标为未接收，可以使用原业务编号重试。这不改变账号授权、本地模型隐私或根据 CPU、内存调整的执行并发预算。

创建进程时不持有会话全局锁。取消操作保留本次启动的准确归属，直到确认进程树清理完成；未确认退出不会释放该执行名额或允许替代执行。事件保存失败会保留尚未保存的批次，成功重试后才恢复 Hub 执行准入；当前快照为空或其他事件收到确认，都不能丢弃该批次。桌面本地执行的准入仍独立于 Hub 事件保存状态。

模型元数据从快照采集到远程投影始终携带当时的隐私分类。在读取期间切换到 Hub 模型，不会使旧本地模型标识或 token 统计被上传。附件读取和补充消息的后台线程也会保留取消归属，直到实际操作结束。

在后端测试环境运行 `python3 -m unittest test_runner_local_rpc test_runner_remote_rpc test_runner_event_delivery test_runner_usage_receipts test_runner_input_cleanup test_local_process_cleanup test_task_goal_stop_races`。私有管道测试使用真实 Runner 进程和持久队列，底座检测为模拟；进程清理测试使用隔离的操作系统子进程。在其他平台运行这些检查，不代表已完成真实模型或 Windows 验收。

## 质量门禁

本机需求准备阶段将 `executionSubmissionChoice` 与实际的 `executionSubmissionMode` 分开保存。选择自动判断时，本轮完成且校验通过的正式成果会触发自动提交验收；明确手动及来源不明的历史手动值保持原行为。验收仍由需求创建人执行。本轮交付问题会显示采集中断、成果无效或创建人不可用，不改变审批权限。新的策略确认和问题回执需要桌面与 Hub 一起更新。

所有后端冒烟都登记在 `quality_manifest.py`，新增脚本未登记会直接阻断发布：

```bash
# 先在专用虚拟环境安装测试依赖（含 Runner 构建契约所需 PyInstaller）
python3 -m pip install -r requirements-test.txt

# 日常提交 / CI：离线发布门禁
python3 quality_gate.py --profile release --scope backend

# 发布前：完整离线回归、客户端测试与管理端生产构建
python3 quality_gate.py --profile extended --scope all

# 查看发布、扩展、真实环境三层清单与前置条件
python3 quality_gate.py --list
```

`live` 层可能连接真实 Hub、Runner、代码平台、模型或业务库，默认拒绝执行，不能用来替代离线发布门禁。详细口径见 [`../docs/release-scope.md`](../docs/release-scope.md)。

人工提交验收将验收请求与通知任务放在同一事务中提交。HTTP 回执不等待设备通知发送，避免慢连接让已经成功提交的需求仍显示为可重试。现有通知工作进程会重试发送失败，并按接收人当前权限重新生成通知内容。运行 `py -m unittest test_local_requirement_delivery` 可验证回执、幂等与事务回滚。

在 `client/` 目录运行 `node e2e/run-requirements-isolated.cjs /绝对路径/证据目录 /测试环境/python路径 requirements-manual-submit-race`，可通过隔离 Electron 与 HTTP 验证生产客户端超时和合成慢通知接收端的组合。测试使用独立数据库和文件，不使用真实账号，也不发送外部消息。

离线检查拥有各自的子进程树，并在清理完成后返回，包括命令先于后代进程退出的情况。在 Windows 上，门禁复用仓库中的 Windows PowerShell Job 辅助程序，确认 Job 分配成功后才允许命令执行。输出采集到私有临时文件，避免后代继承输出句柄导致超时后无限等待；失败报告保留超时前产生的输出。运行 `py -m unittest test_quality_gate_cleanup` 可验证当前平台上的真实进程清理回归。

受权限控制的回合在结算或开始下一轮前，必须确认执行宿主已退出。已有可靠的 Agent 退出记录时，正常收尾最多等待 30 秒，例如冻结程序清理自己的解压目录；取消和权限变更仍使用较短的停止期限。终止无法确认时继续跟踪原进程并阻止替换，不能仅凭已有回答或终止请求成功就判定完成。可运行 `python3 -m unittest test_local_process_cleanup`，使用隔离子进程验证延迟退出与终止未确认的行为。

冒烟脚本集中在 [`smoke/`](smoke/) 目录。单独运行时，在 `hub-backend/` 目录使用模块命令，例如 `python3 -m smoke.smoke_capabilities`；质量门禁会选择已登记的模块。单元测试和 `tests/` 集成辅助脚本保留现有位置。

## DeepSeek Harness 回合完成状态

DeepSeek ACP 适配器 0.4.40 和 0.4.41 可能在子代理仍运行时返回完成。SoduWork 的宿主专用预加载器通过原生 `waitForChildren` 服务等待正在推进的后代，再复查父代理空闲状态及会话序号。子代理结果唤醒父代理的新回合后，会保留最后回合的输出上限或错误。取消会结束等待，驻留但空闲的子代理不会使已完成提示永久等待。

预加载器在 macOS、Linux 和 Windows 上对经过核对的适配器提示结算和工具预览代码应用内存兼容修复，不改写安装包及原生会话文件。未知适配器版本或变更后的代码块会明确要求更新 SoduWork，避免静默使用有缺陷的行为。源码及冻结 Runner 均包含该加载器。

在根目录执行 `node --test client/tests/dsh-acp-settlement.test.cjs`，验证离线生命周期和加载行为。在 `hub-backend` 执行 `python3 e2e_dsh_subagent_settlement.py --adapter-entry /absolute/npm/root/@openma/deepseek-harness-acp/dist/bin.js --runtime-root /absolute/runner/data/agent-runtimes/dsh-host --node /absolute/path/to/node --output /absolute/evidence/directory`，可使用明确指定的已安装适配器与合成回环模型进行隔离验收，不调用生产模型或桌面 UI。

收到 `max_tokens` 时，经过核对的适配器只把原生状态为 pending 的工具预览标记为未执行，再清理预览。DSH 在执行前就会丢弃这些调用；真正开始执行的工具仍须等待实际结果。宿主在实时和历史工具卡片中保留这个区别，后续真实失败也不会被旧取消状态掩盖。

工具活动结束后，DeepSeek Harness 可在原会话中从已保存的结果接着做，并使用更小的工具调用。自动恢复最多续跑一次，只有原生压缩成功后才能再续跑一次。持续达到上限时，会显示本轮未完成并保留进度，不再作为协议错误呈现。续跑成功会清除旧截断状态；协议错误和宿主清理失败仍优先处理。

使用托管模型路由时，SoduWork 显式启用 DeepSeek 原生自动压缩并配置预算，
在当前回合的工具步骤之间执行。
触发阈值取模型上下文窗口的 80% 与扣除当前输出、摘要预算后剩余空间的较小值。
摘要输出不超过模型配置的输出上限，不再沿用原生的 65,536 token 预留。
正常输出上限保持不变；只有几乎占满上下文窗口的输出上限才会下调，为输入留出空间。
原生压缩保留当前会话、工具结果、权限与取消归属，无需用户再次发送消息。
这不会把模型单次输出上限误判为上下文溢出，也不会移除上述有界续跑限制。

运行 `python3 -m unittest test_dsh_gateway test_context_recovery
test_acp_error_messages test_local_turn_outcome` 可验证模型预算与恢复回归。
配置或推断的上下文大小仍需符合实际服务限制；如果窗口连原生指令和工具定义都容纳不下，
仅靠压缩无法解决。

真实原生进程验证可运行 `python3 e2e_dsh_auto_compaction.py`，使用上述生命周期验证相同的
`--adapter-entry`、`--runtime-root`、`--node` 和 `--output` 明确路径参数。
合成本机模型服务使 64k 窗口在一条用户需求内反复压缩；测试与旧的仅配置模型路由的 bundle
对照，检查持久检查点和已完成工具，并要求压缩后的原生用量回执下降。
这不替代生产模型或桌面界面验收。

托管 Kimi 和 Qwen 同样接收所选模型的上下文窗口，不再沿用更大的原生默认值。
Kimi 接收明确配置的输出上限；Qwen 保留管理员的采样与输出参数。
二者均使用各自原生的步骤间压缩。托管 Codex Harness 接收模型窗口和 80% 的自动压缩阈值。
个人账号版 Codex 保留原生模型设置；OpenCode 已传入上下文与输出限制，并保留原生自动压缩。
运行 `python3 -m unittest test_kimi_runtime test_qwen_runtime test_acp_permission_inputs
test_codex_account_acp` 可验证这些配置与隔离边界。

DeepSeek 运行时预检按归档锁定版本检查 Windows、macOS 和 Linux 的 x64/arm64
sharp、koffi 和 ripgrep 包；macOS/Linux 还检查 libvips，Linux 区分 glibc 与 musl
二进制。清单缺失、版本错误或关键加载器/二进制缺失会阻止激活临时安装，并使缓存的
就绪结果失效。修复失败保留原运行时。执行 `python3 -m smoke.smoke_dsh_runtime`
可验证离线平台矩阵、激活和缓存回归。这些静态检查不能证明任意二进制损坏或
macOS Gatekeeper 已通过；目标平台仍需实际验证 ACP 和工具执行。

## 其他底座的终止结果

托管安装和更新固定使用已验证版本：DeepSeek ACP 0.4.41、Kimi Code 2.6.2、Qwen Code 0.27.4。版本检查也以这些目标为准，包括本机已安装更高版本的情况。SoduWork 完成兼容性验证后再升级固定版本；读取安装状态不会替换本机软件。

Kimi Code 2.6.2 和 Qwen Code 0.27.4 也可能把原生输出上限转换为 ACP 成功响应。宿主专用预加载器保留其原生最终结果，核验经过审阅的完整源码摘要，并对未知版本明确提示更新。预加载器不改写安装包或工具执行行为，随 macOS、Linux 和 Windows 的 Runner 分发。Qwen 的宿主加载器要求 Node 22.15 或更高版本，即使旧安装包声明了更低的引擎要求，也不能降低此要求。

Kimi 在工具参数校验后仍保留最终模型停止原因，并将原生失败回合报告为失败。Qwen 保留自身有界输出恢复，传播恢复期间的真实错误；其单独的会话输入预算不会被误标为输出上限。SoduWork 的单次调用 Qwen 配置使用原生 `model.loopProtection = "stop"`，让已检测到的重复失败停止，而非只提示。该托管调用会覆盖 `warn`/`off`，但不改写运维配置文件，也不降低正常任务的总体预算。两者耗尽原生输出恢复后，宿主均不会叠加重试。

Codex ACP 协商带版本的 `sessionFailure` 能力，在接受 `end_turn` 前读取当前提示的结构化失败；错误文本不能作为完成证据，无法解析的结构化失败也会阻止成功结算。该 v1 能力也会改变工具报告：审批省略的字段仅从同一个仍有效的工具调用恢复，终端增量和结果快照经过有界缓存后仍保留在已结束的工具卡片中；此次协商不会开启原生子代理会话能力。Pi、OpenCode、DeepSeek、Kimi 和 Qwen 均保留后续真实错误，避免被此前的截断掩盖；真正恢复成功后会清除旧截断状态。

可在后端测试环境执行 `python3 -m unittest test_kimi_runtime test_qwen_runtime test_codex_acp_outcome test_acp_error_messages test_local_turn_outcome`。独立夹具 `e2e_kimi_outcome.py`、`e2e_qwen_turn_outcome.py` 和 `e2e_codex_acp_outcome.py` 使用明确指定的已安装底座及隔离本机回环模型，所需路径见各自 `--help`。Codex 验收还检查真实审批的批准、拒绝和命令输出，不调用付费模型服务。

## 任务文本兼容

通过 `POST /api/v1/tasks` 新建任务，以及 `PATCH` 或批量更新中明确提交的字段，
标题最多 200 个字符、来源最多 120 个字符；超长输入会在写入前返回 422。
读取历史记录、修改无关字段时保留原有文本。

`PUT /api/v1/tasks/{id}` 是桌面端幂等同步和撤销删除使用的接口。
升级前尚未同步的任务、删除后恢复的任务都可能没有服务端记录，因此该接口接收完整历史文本，
有意不套用 POST/PATCH 的文本长度限制；账号所有权和平台管理来源限制继续生效。

迁移 `0092_task_text_storage` 无损扩容 PostgreSQL 的任务文本列，
也覆盖尚未使用版本化迁移的旧数据库；已有 SQLite 表不需要重建。
先部署 Hub 并完成迁移，再升级桌面端。桌面端保留完整文本，
对仅因旧长度校验而阻塞的 PUT 队列记录重试一次；再次被拒绝则保留阻塞，等待明确处理。
存在超长数据时，降级会拒绝缩窄字段。升级前请备份数据库和匹配版本的程序。

## 连数据库

领域排序接受 32 位有符号整数及旧客户端使用的十进制整数字符串。非法值、
布尔值、小数和越界值会在修改记录前返回 HTTP 400。PATCH 省略排序或传入 null
时保留原排序，创建时仍默认使用 0。调度数字字段和客户端更新进度使用相同的
整数校验，并保留原有范围限制和可选字段默认值。新提交的调度时区必须是有效的
IANA 时区；省略时保留原配置，null 或空字符串沿用默认时区。历史无效时区仍可
通过默认时区回退正常读取。

迁移 `0091_domain_sort_validation` 修复 SQLite 中存储类型或范围异常的历史领域
排序，保留正常排序、领域 ID 和关联关系。排序仍有空间时，修复项排列在正常项
之后；若已达到上限，则在上限并列，并按创建时间和 ID 排序。每次修复会在同一
事务中先写入 `domain.sort_repair`
审计记录，保存原存储类型、原值的无损表示及替换值。首次接管旧版未使用 Alembic
的数据库时也会执行此修复，重复运行不会重复处理。PostgreSQL 的领域数据保持不变。
升级前请备份数据库；降级不会恢复异常值。管理员可通过审计记录复核并调整排序。

离线回归命令：`python3 -m unittest test_api_integer_validation
test_domain_sort_validation test_domain_sort_migration
test_schedule_update_input_validation`。这些测试已登记到发布质量检查清单。

在 `.env` 里设 `DATABASE_URL`：

| 场景 | DATABASE_URL |
| --- | --- |
| 本地零配置（默认） | `sqlite+aiosqlite:///./soduwork_hub.db` |
| 自建 PostgreSQL | `postgresql+asyncpg://soduwork:<PASSWORD>@db.example.com:5432/soduwork` |
| 单机 Docker 自部署 | 根目录 `python3 ops/self-host/deploy.py up`，自动生成独立实例的数据库口令 |

> **密钥不入库**：`.env` 已被 `.gitignore` 排除；部署凭据通过密钥管理或环境配置提供，勿写进提交文件。
> 使用专用数据库和最小权限账号；部署与备份恢复见 [`../ops/self-host/README.md`](../ops/self-host/README.zh-CN.md)。实际内部地址和运维记录应单独保管。

内置技能正文从部署目录 `skills/` 发现。Hub 启动时在现有 `app_setting` 表的
`skills_cfg` 记录中初始化版本化策略。新安装和旧策略首次升级会开放所有内置技能，
包括管理员以前关闭的项。升级后管理员再次关闭的项会跨重启保留，后来新增的内置
技能默认开放。个人选择与导入包审批保持独立。详见[技能加载说明](../skills/README.zh-CN.md)。

## OpenCode 数据隔离与旧会话

受管 OpenCode 的数据库、数据、状态和缓存均存放在 Runner 数据目录下的 `agents/opencode/` 中。继承的 `OPENCODE_DB` 和 XDG 路径不能再将受管执行指向个人 OpenCode。父 Runner 与独立 ACP 桥使用同一个私有数据库；用户主目录和本轮注入的模型配置保持不变。

新建和恢复会话都会在启动前检查目录，拒绝逃出此私有目录的子路径，以及数据库和 SQLite 附属文件的硬链接。明确重定向的 Runner 根目录，以及仍位于其 OpenCode 目录内的链接继续支持。不安全的目录布局会阻止 OpenCode 启动，也不会新建替代会话，需要修复后重试。

归档的 SoduWork 会话续聊时，以已有原生会话 ID 和工作目录确定需要恢复的历史。从稳定的只读文件快照中，将兼容的 v1 会话、消息、内容片段和待办记录，以及相关子会话导入私有数据库。不导入个人账号、凭据或项目权限，也不修改原数据库及其附属文件。找不到原会话、所选会话或子会话含不兼容的 v2 历史、存在进行中的撤销状态或远端工作区绑定时，会停止恢复并说明原因；不会静默新建空会话或降级个人数据库。即使数据库仍含 v1 表，也能识别相关 v2 历史，同时不会阻止无关的 v1 会话迁移。如果读取快照期间个人数据库仍在变化，请关闭个人 OpenCode 后重试。已有会话归档和原生 ID 保留。

若私有会话已经存在但为空，能够核实的原始历史会阻止继续使用该空会话，同时保留私有数据库。个人存储缺失或不可用时，合法的私有会话仍可恢复。压缩期间取消执行，即使同时发生历史恢复错误，也会正确结算为已停止；过期的恢复过程不能覆盖新一轮执行。

使用固定的受管二进制和准备好的 SDK 依赖，运行 `SODUWORK_TEST_OPENCODE_BIN=/absolute/path/to/opencode python3 -m unittest test_opencode_native_config`，可通过本地回环模型验证原生及 ACP 数据隔离和续聊。检查使用合成数据库，不访问个人历史或生产模型。

## OpenCode 回合完成状态

OpenCode 原生和 ACP 执行均保留当前回合的模型停止原因。达到输出 token 上限时，即使已有部分文本且原生进程正常退出，也会标记为未完成；已有进度和会话保留，可人工继续。ACP 适配器使用单次调用的临时插件，只观察原生会话、回合标识及停止原因；缺少完成证据时阻止成功结算，不重试工具或改变权限。执行 `python3 e2e_opencode_turn_outcome.py --binary /path/to/opencode`，可用明确指定的已安装二进制和隔离的本地回环模型服务进行验收。

## OpenCode 安装与网络诊断

macOS、Windows 和 Linux 上的 Runner 归档下载、模型网关连通性预检与安全控制连接共用一套 TLS 配置。默认通过 MIT 许可的 `truststore` 使用安装机的系统信任：macOS 使用 Security framework，Windows 使用 CryptoAPI，Linux 通过 OpenSSL 使用系统 CA 存储。不追加随包提供的公共 CA 文件。原生验证能力缺失或证书被拒绝时直接失败，不换另一套信任策略重试。证书链与主机名仍须通过校验。这不改变外部原生底座自身的 HTTPS 配置。

非空的 `SSL_CERT_FILE` 或 `SSL_CERT_DIR` 会用指定的 CA 文件或 OpenSSL 哈希 CA 目录明确替换默认系统信任。路径缺失或无效时直接失败，不回退到系统或随包根证书。配置此覆盖时应提供完整的所需信任集合。空值使用默认系统信任。HTTP 客户端仅在 HTTPS 请求时加载证书，包括从 HTTP 跳转到 HTTPS；普通 HTTP 不依赖证书配置。现有下载代理选择和模型网关直连策略保持不变。

受管安装器依次尝试明确配置的镜像、当前连接的 Hub 和官方发行源。macOS 上通过 Python 安装器下载归档时，每次尝试都会按协议合并系统 HTTP/HTTPS 代理与环境变量覆盖值。明确设为空的代理变量会禁用对应协议的系统代理。来自系统的代理同时保留系统绕过规则和 `NO_PROXY`；空 `NO_PROXY` 不会取消系统例外。显式代理覆盖仍采用标准环境绕过行为，当前 Hub 的精确来源（协议、主机、端口）保持直连。TLS 证书校验和固定 SHA-256 校验始终启用。这些下载规则不改变 npm 依赖安装或模型网关的连接策略。

准备 Hub 镜像时，应使用与客户端预期一致的代码版本和固定 OpenCode 版本。不带参数运行 `fetch_opencode_assets.py` 只准备 Windows 资产。若需服务 Apple Silicon 和 Intel Mac，在该 Hub 代码目录的 `hub-backend/` 下运行：

```sh
python3 fetch_opencode_assets.py darwin-arm64 darwin-x64 darwin-x64-baseline
```

脚本先验证固定 SHA-256，再将文件发布到 `downloads/opencode/`。部署这些文件后，通过 `GET /api/v1/download/opencode/info` 核对版本、平台和 `filename`，再用精确文件名下载 `/api/v1/download/opencode/{filename}`。`available: true` 仅代表文件存在；还需按固定摘要校验下载内容。Runner 在解压前也会独立校验该摘要。在代码目录准备好文件，不代表远程 Hub 已提供这些文件。

安装失败时，查看本地 Runner 的 `runner.log` 中的结构化网络诊断及失败阶段。元数据请求、部分下载、摘要校验或 `--version` 探测单独成功，都不等于安装完成：下载、完整性校验、解压、可执行文件版本检查、执行依赖准备和激活必须全部成功，之后还要单独验证模型执行。共享诊断时不得包含凭据和原始代理配置；证书问题应修复可信证书配置，不得关闭 TLS 校验。

在装有 `requirements-runner-build.txt` 依赖的专用环境中，用真实本机回环 HTTPS 和 PyInstaller 冻结探针验证生产网络模块：

```sh
python3 e2e_runner_tls.py --output /absolute/evidence/directory
```

检查覆盖随包原生验证模块、使用临时信任锚的真实 TLS 握手、显式信任覆盖，以及拒绝不可信证书和主机名不匹配的证书；不修改机器的证书信任存储。`--source-only` 可不打包执行同一调用路径。这些测试不能替代完整桌面、生产模型或其他操作系统验证。

## API 概览

- 客户端契约（设备登记 → 管理员激活 → 短期 `Device` 会话；长期设备密钥在 Hub 只存摘要）
  - `GET/POST /api/v1/tasks`、`GET/PATCH/DELETE /api/v1/tasks/{id}`
  - `POST /api/v1/tasks/batch-update`、`POST /api/v1/tasks/clear-done`（只清 done）
  - `POST /api/v1/tasks/{id}/agent/{run|retry|takeover}`
  - `GET/PUT /api/v1/config`
  - `POST /api/v1/clients/enroll`（登记/心跳，激活后签发短期会话）
  - `WS /api/v1/ws?device=<设备ID>&session=<短期会话>`（实时推送）
- 管理端
  - `POST /api/v1/admin/login` `{user,pass}` → 短期登录 token
  - `GET /api/v1/admin/clients`、`GET /api/v1/admin/tasks`（需 `Authorization: Bearer <token>`）
  - `POST /api/v1/admin/dispatch` `{title,...,targets:[设备ID]}` → 平台建任务下发（origin=dispatch）

## 客户端接入

设备长期密钥只由 Electron 主进程持有。客户端通过 `POST /api/v1/clients/enroll` 登记并轮换短期会话，
业务请求使用 `Authorization: Device <session>`，WebSocket 使用同一短期会话；长期密钥不得进入渲染进程、日志或 URL。
任务与流程状态以 Hub 为唯一事实源，本地缓存只用于断网展示和待同步命令，不能反向覆盖服务端新状态。

禁用账号会使其已有设备会话及 AI/工具凭据失效，将设备退回待登录状态，并断开事件、终端和 Runner 连接；保留设备密钥、配置和历史归属。同一设备可以登录其他正常账号，原账号重新启用后需要重新登录，旧会话不会恢复。管理员单独停用的设备继续保持停用，阻止所有账号登录。旧版账号禁用逻辑已造成的设备停用，需要管理员核实后激活；重新启用账号不会自动解除设备停用。

账号会话目录与来源投影包含 `contentLocation`：旧 Hub 正文为 `hub`，原始终端保留正文为 `source`，源版本匹配的有效迁移副本为 `replica`，无法确认引用时为 `unknown`。该字段不暴露私有副本标识，也不授予访问权限；客户端仍须执行既有账号、Hub 与执行权限检查。不能根据未知位置删除可能独立存在的本地副本。

### 统一需求池升级边界（0053）

需求列表、详情和更新使用原 `/api/v1/tasks` 契约。`requirementContent` 是需求正文；已有交付 Task 的 `title/note` 仍可能包含私人执行上下文，需求编辑应携带 `requirementVersion`，只更新需求投影。`canEditRequirement` 与 `canViewExecution` 分离；共享需求不会开放执行记录、评论或输出附件。

需求项目选择复用 `GET /api/v1/projects` 中有效的 Hub 业务项目、原有组织范围及公开项目。只有需求所属设备和账号能够在从未开始执行时，携带当前 `requirementVersion` 更改或清除 `projectId`；`null` 表示取消关联。已关联仓库的需求固定归属原项目。明确新增的关联必须有效、可见且与仓库一致；未改变的历史关联和仅传仓库的旧调用保留原有行为。个人对话项目不是 Hub 业务项目。

旧需求并入交付 Task 时，完整原记录保存在 `legacy_requirements`，旧创建人、需求方和经办人的范围保存在 `task_requirement_access`。只有部分原需求权限的人只能读取自己的快照和材料，不能改写聚合需求或查看其他原需求。列表、详情、附件访问和 WebSocket 使用同一规则。归档后需先恢复再派活；完成后归档保留验收和完成状态。

升级前必须备份数据库和匹配版本程序。0053 在事务中迁移并删除旧表；文件内容及对象存储键不变。同一交付 Task 的原需求若来自不同可见范围，升级明确失败并回滚，不能静默扩大权限。重复执行不会重复迁移。统一需求开始产生新写入后，自动降级被禁止，应使用升级前数据库备份和对应程序一起回滚。旧 `/work-items` 路由返回 410，旧插件 `work.task.create` 仅作为统一 Task 创建的别名。

隔离验证入口：`python3 -B tests/unified_requirements_upgrade.py --sqlite` 和 `python3 -B tests/unified_requirements_upgrade.py`。后者仅创建随机本机 PostgreSQL 临时实例，完成后停止并清理，不使用业务数据库。权限回归为 `test_unified_requirements_acl.py`，包含真实迁移后的 HTTP 多身份和 WebSocket 投影检查。

## 非 Pi 底座的任务续跑

选择目标模式，或在桌面消息中明确要求持续完成时，Codex、Codex Harness、OpenCode、DeepSeek Harness、Kimi 和 Qwen 使用 Runner 统一的任务控制器。Pi 保持原有控制机制；普通提问及未提出持续完成要求的指令保持原来的单轮行为。

输出截断、上下文恢复和任务完成分别判断。只有明确类型的输出上限结果才能触发输出恢复；认证、传输、权限及工具结果不明都不能据此重试。由任务控制器接管的 DeepSeek 轮次会关闭桥接层内部的输出重试，避免新进程放大次数。任务记录最多允许两次输出恢复，第二次必须有新的成功工具进展。上下文恢复保留独立计数，可压缩或接力原生会话，同时保留 SoduWork 会话和工作区。

工作轮成功结束后，单独的复核轮检查实际产物和验证结果。只有本轮有效的结构化结论、本复核轮真实成功的工具证据，以及已声明产物的检查都满足，才认定完成。这是模型辅助复核，不能证明任意业务要求必然正确。缺少证据、结论格式错误或不支持的证据会暂停任务；连续两轮没有新的成功工具进展也会暂停。原权限和审批要求始终有效。

默认预算为 240 分钟和 1,000 个工具步骤。累计活动时间、工具步骤、复核状态及恢复次数会跨内部续跑和 Runner 重启保存。暂停期间不计活动时间，继续不会补充预算。用户新消息在原生轮次结束时优先处理；停止和关闭目标会阻止自动重启，包括执行宿主正在收尾的情况。关闭目标保留文件，并允许继续普通对话。

运行 `python3 -m unittest test_local_task_goal test_local_task_goal_integration test_context_recovery test_acp_error_messages` 验证控制器及关键边界。检查使用合成结果和隔离进程，不代表所有真实模型的交付质量验收。

已有兼容的 DeepSeek 安装时，运行 `python3 e2e_task_goal_dsh.py --adapter-entry /absolute/adapter/dist/bin.js --runtime-root /absolute/runner/data/agent-runtimes/dsh-host --node /absolute/path/to/node --output /absolute/evidence/directory`。检查使用已安装的适配器、运行时、真实文件工具及生产流解析、任务控制器和恢复代码；模型响应与进程调度回调使用测试替身。它要求截断恢复后在同一原生会话完成文件复核，已有文件保持不变，写入不会重复。不安装依赖，也不使用生产凭据。

## OpenCode 恢复会话时的模型选择

受管 OpenCode 原生命令会明确传入本轮模型；ACP 路径在发送提示词前选择组件实际公布的精确模型标识，并保留原会话 ID 和历史。仅更新注入配置中的默认模型，无法替换原生会话记住的模型。找不到指定模型或组件未确认切换时，本轮停止执行；适配器不会恢复旧凭据、改写模型名称或新建替代会话。

安装后端测试依赖后，可运行 `SODUWORK_TEST_OPENCODE_BIN=/absolute/path/to/opencode python3 -m unittest test_opencode_native_model_selection`，通过回环模型接口验证原生命令与 ACP 的模型切换。测试使用隔离的原生状态和合成凭据，检查三轮执行的历史保留、模型标识和凭据更新，不覆盖生产模型服务或桌面界面。

## 需求自动化草稿

具有管理权限的用户可将未归档需求的公开内容复制为独立的自动化草稿。打开或取消表单不会创建记录。保存始终创建未启用的自动化，不改变原需求、需求版本或已有自动化关联。之后编辑或启用自动化与原需求相互独立。

此路径的 `POST /api/v1/schedules` 接收 `sourceRequirement: {id, requirementVersion}` 和稳定的 `creationRequestId`。Hub 检查当前管理权限、归档状态和预期版本，随后由服务端生成 `source_requirement` 快照，记录来源 ID、公开标题及版本。响应以 `sourceRequirement` 返回这三项；普通自动化编辑不能替换来源，来源记录也不会扩大对原需求的访问权限。不复制执行路由、凭据或本地模型引用。

同一账号、设备重复发送相同创建请求会返回已创建的自动化；同一标识携带不同内容时返回 409。原需求后来发生变化也不影响恢复丢失的创建响应。迁移 `0088_schedule_requirement_source` 为已有自动化增加默认空 JSON 字段，不推断历史来源，也不改写旧关联。

## 受管 ACP 状态目录

Codex Harness、Qwen、Kimi 和 DeepSeek Harness 使用 Runner 数据根目录下的独立状态目录。如果权限、同名文件或存储故障导致目录无法创建，准备阶段会在启动执行组件前拒绝本轮执行，并返回不含个人路径或文件系统异常内容的可操作提示。继承的个人状态保持不变；修复目录后，可以通过正常准入检查重新派发。

`python3 -m unittest test_acp_home_isolation` 验证真实文件冲突、模拟权限拒绝，以及真实子进程与 ACP 桥接下使用合成底座的 Runner 准入流程，确认准备失败时执行组件未启动、修复目录后能够执行。这不等同真实模型服务或原生平台验收。

## ACP 文件与 Kimi 问答契约

ACP `fs/read_text_file` 在省略 `limit` 时返回完整 UTF-8 文件并保留换行符；显式正整数 `line` / `limit` 用于范围读取。超过宿主 4 MB 限制的文件会明确报错，桥接不会静默截断内容后再交给原生编辑工具写回。

Kimi 的 `AskUserQuestion` 权限回退会显示为具体答案选项。用户选择的 `optionId` 经桌面端和 Runner 原样回传；完全访问模式也必须等待用户回答，取消问题不会授权或拒绝后续工具操作。此回退保留 Kimi 只处理第一个问题、单选的行为，客户端不声明支持 elicitation 表单。显式标记 `localOnly: true` 的受管 Kimi 模型允许省略 API 密钥：启动环境会注入满足 Kimi 校验的固定非秘密占位值，不修改已保存凭据或远程模型校验。

离线回归命令为 `python3 -m smoke.smoke_acp_runtime`、`python3 -m smoke.smoke_access_policy` 和 `python3 -m unittest tests.test_cli_runtime_compatibility`，覆盖完整文件编辑与追加、问答选择与取消、本地模型环境构造。另使用真实 Kimi Code 2.6.2 和回环模型接口验证了原生 ACP 行为；这不代表外部模型服务验收。

## DeepSeek Harness 私有探测

本地模型测试隔离 DSH 的可写状态和临时文件，同时从 Runner 已安装的运行时目录解析 `DSH_PATH`。隔离测试状态不能改变已安装代码的位置。私有作业及模型服务原始输出仍不能通过 Hub 作业 API 获取。

准备后端测试依赖及已有兼容的 DSH 安装后，运行：

```sh
python3 e2e_dsh_private_probe.py \
  --adapter-entry /absolute/npm/root/@openma/deepseek-harness-acp/dist/bin.js \
  --runtime-root /absolute/runner/data/agent-runtimes/dsh-host \
  --node /absolute/path/to/node \
  --output /absolute/evidence/directory
```

此显式检查使用生产私有探测作业和 ACP 桥接、实际安装的适配器与运行时，以及合成本机回环模型。先重现旧安装路径错误，再要求修正路径后出现真实模型请求并由 Agent 返回预期响应。检查使用可清理的用户目录、状态和临时目录，阻止 Node 连接非回环地址，并清理自身子进程；不会安装或更新依赖，也不使用真实凭据，不覆盖桌面界面、生产 Hub 或模型服务行为。由于需要已有原生安装，请在离线质量门禁之外单独运行。
