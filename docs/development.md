# 开发指南

**简体中文** · [English](development.en.md) · [文档导航](README.zh-CN.md)

命令示例中的 `sh start.sh` 适用于 macOS/Linux；Windows PowerShell 使用 `.\start.cmd`，命令提示符使用 `start.cmd`，参数相同。独立 Python 工具示例使用 `python3`；Windows 使用 `py`，已激活虚拟环境时使用 `python`。

## 第一次进入项目

先按[启动指南](getting-started.md)运行 `sh start.sh --desktop`，确认能登录，再选择要修改的工程。根目录只放项目入口、许可和贡献说明；依赖、构建与分发配置跟随对应工程。

| 要修改的内容 | 代码入口 | 本工程说明 |
| --- | --- | --- |
| 桌面窗口、对话、用户设置 | `client/main.js`、`client/main/`、`client/core/`、`client/components/` | [桌面客户端](../client/README.zh-CN.md) |
| API、权限、数据、任务执行 | `hub-backend/app/main.py`、`app/api/`、`app/services/`、`runner_main.py` | [Hub 后端](../hub-backend/README.zh-CN.md) |
| 浏览器中的管理页面 | `hub-frontend/src/main.jsx`、`hub-frontend/src/` | [管理端](../hub-frontend/README.zh-CN.md) |
| 技能、插件与工作流 | `skills/`、`hub-backend/plugins/` | [插件协议](plugin-authoring.md) |
| 本地启动与部署 | `start.py`、`tools/dev/`、`ops/self-host/` | [自托管](../ops/self-host/README.zh-CN.md) |
| 分发范围和完整性 | `tools/distribution/`、`tools/export_source.py` | [源码分发](open-source.md) |

上表中的后端 `app/` 和 `runner_main.py` 均相对于 `hub-backend/`。三个工程分别安装依赖；根目录没有统一的 npm 工作区。

## 管理页面

推荐开发循环：一个终端从根目录运行 `sh start.sh`，另一个终端启动 Vite。源码服务默认端口为 **18989**；Vite 默认后端为 **9080**，因此需要显式设置代理目标。

PowerShell：

```powershell
cd hub-frontend
npm ci
$env:SODUWORK_DEV_HUB = 'http://127.0.0.1:18989'
npm run dev
```

macOS / Linux：

```sh
cd hub-frontend
npm ci
SODUWORK_DEV_HUB=http://127.0.0.1:18989 npm run dev
```

打开终端显示的 Vite 地址（默认 **http://localhost:5173**），使用本地 Hub 的账号登录。修改 `src/` 后页面自动更新。完成后在本目录执行：

```sh
npm run build
node --test tests/*.test.mjs
```

## Hub 后端

`app/api/` 接收请求并校验访问权限，`app/services/` 实现业务逻辑，`app/` 下的数据模型与 `migrations/` 管理持久化和迁移。`runner_main.py` 是执行机入口；Hub 与 Runner 的信任和权限应分别处理。

根启动器将代码同步到私有运行副本，**不会热更新正在运行的后端**。修改源码后停止启动器，再运行同一命令，保留原有数据。不要编辑数据目录里的 `application/` 副本。

需要自动重载时，按[后端说明](../hub-backend/README.zh-CN.md)建立独立开发环境并运行 Uvicorn；默认使用 9080 端口。使用隔离数据库和临时账号，配置文件仅保存在本机。数据库结构变更新增 Alembic 迁移；不要删除用户数据来绕过迁移。

后端在自己的环境中执行检查：

```sh
cd hub-backend
python3 -m pip install -r requirements-test.txt
python3 quality_gate.py --list
python3 quality_gate.py --profile release --scope backend
```

完整离线门禁耗时较长；日常修改先运行清单中对应的检查。`live` 检查连接真实服务或模型，需要自行准备隔离环境，不包含在默认离线验证中。

## 桌面客户端

桌面是 Electron + 原生 HTML/CSS/JavaScript，管理页面是独立的 React 应用。主进程位于 `main.js` 和 `main/`，受限 IPC 桥位于 `preload.js`，界面主要位于 `desk.html`、`core/` 和 `components/`。

保持 Hub 运行，另开终端：

```sh
cd client
npm ci
npm start
```

独立源码启动的客户端在未保存服务地址时，默认连接 `http://127.0.0.1:18989`，适用于默认端口的本地 Hub 或 Docker 自托管服务。已保存的地址继续生效；使用其他端口时在登录页更改服务地址。它与根启动器 `--desktop` 使用的专用配置不同，后者自动连接本次启动的 Hub 并跟随 `--port`。打包及正式客户端未保存地址时仍默认连接 `https://service.soduwork.ai`。修改主进程后退出应用并重启；修改界面脚本时也应重新打开客户端验证装载顺序和交互。

在 `client/` 运行 `npm test` 和 `npm run check:layout`。Electron 端到端检查见本目录的 `e2e/`，按脚本选择所需环境。`dist/`、`.runtime/` 和生成的 `runner/` 文件是产物，不要提交或复制旧版二进制替代源码。

### 本机会话、记忆与交付文件

桌面使用自己的会话 ID。设备对话正文和工具回执存放在应用数据的 `conversation-replicas/history.sqlite`，CLI 的原生 ID 只用于衔接执行。同设备的普通聊天可在账号切换后查看。账号资源、项目任务、导入记录和云端执行仍使用各自的归属校验。

`conversation-artifacts/` 保存经过本机会话回执核验的交付文件。进入历史列表后，客户端会在后台分批升级旧工作区的回执，打开会话时也会复核。只有仍与旧回执匹配的原文件才能补存。若第三方已清理原文件，且此前没有副本，标题或回复中的文件名无法重建文件。备份设备前请一并保留桌面应用数据和有价值的工作文件。每代归档最多保存 4,000 个文件、合计 512 MiB，单个文件上限为 128 MiB。补存期间，有文件仍引用的旧代会继续保留。部分归档会在历史里提示，先前保存的文件仍可查看。

多个普通本地会话可以选择同一工程并原地编辑源码。每个会话把独立交付物生成在自己的 `.soduwork-drafts/<会话标识>/` 下。轮次结束时，桌面核对文件哈希，先将原件保存在应用数据中，再把可编辑的副本投递到所选工程的 `会话成果/<会话标识>/turn-<轮次标识>/`。历史卡片打开该轮保存的版本，网页可以读取当时已核验的本地依赖。编辑或删除工作副本后，仍可从卡片查看和下载原件。每轮可自动核验的单文件上限为 32 MiB。文件超限或本轮变更记录不完整时，桌面会提示，草稿仍保存在原位。只写入共享工程路径的文件归入工程改动。旧会话继续使用已有的核验记录，找回更早的版本需要当时已保存该版本的文件内容。

桌面可以复用支持所需协议的已安装 CLI 程序。Runner 为底座指定应用管理的数据目录，保留原生执行分段。Codex 个人账号在当前 SoduWork 账号名下连接，模型目录和对话共用这个连接。旧连接无法确认归属时，需要在该账号重新连接一次。终端中的 CLI 仍可按原配置独立使用。

自动生成的项目和工作区记忆保存在应用数据的 `memory/`，按账号和作用域读取；项目中原有的手写记忆仍可使用。默认工程流程把进度留在任务回复中。新任务可以在最终回复中链接本轮实际生成的文件，旧版交付清单继续可读。

设备迁移需要同账号的两台电脑在线直连、预览确认要传输的文件并完成交权。目标设备重新校验选中的字节；原生 CLI 数据库和模型登录不随会话迁移。工具结果未确认的历史可查看，恢复执行和迁移需要完整回执。

## 技能和插件

`skills/<name>/SKILL.md` 描述内置技能，包括项目自有指南和已核对来源的上游开发技能，见[技能目录](../skills/README.zh-CN.md)；`hub-backend/plugins/*.json` 提供通用插件与工作流。遵循[插件协议](plugin-authoring.md)保持版本不可变、权限最小化及导入审查。新增内置技能还需要显式更新 `tools/distribution/PUBLIC-SOURCE.json` 的发布范围，并保留原始许可和来源说明。

模型、Codex 等执行器及外部插件使用用户自行配置的凭据和授权。不要把外部商业技能、真实密钥、组织地址或业务样本加入示例。

## 提交前验证

从根目录运行与修改有关的检查：

```sh
python3 -m unittest tools.dev.test_start_local
node tools/check-public-source.cjs
node tools/check-repository-layout.cjs
node tools/check-third-party.cjs
node tools/check-docs.cjs
python3 tools/security/scan_secrets.py --download
```

涉及启动过程时，再运行 `python3 tools/dev/verify_local_start.py --desktop`，需要网络和图形桌面。纯文档修改核对链接和命令即可，不必声称完成未实际运行的平台验收。按[贡献指南](contributing.zh-CN.md)审核并暂存新增源码文件；源码包清单在导出时自动生成，不提交到仓库。

## 注释约定

新增公开接口、安全边界和兼容性说明优先使用英文，描述当前行为及原因。内部讨论、个人经历、临时机器环境和失效实现说明应改写或移除。保留协议标识、存储键、测试语义及第三方许可原文；界面翻译、技能指令和 Prompt 单独验证，不与注释整理混改。

GitHub 自动验证范围和平台限制见[配置说明](../.github/CI.md)。秘密扫描只覆盖当前源码，不能代替私有历史审查。

## 文档与翻译

GitHub 上通过页面顶部的相对链接切换语言，下载后的源码也可沿同样路径阅读，无需文档服务。

- 根目录、组件目录和 `docs/` 文档索引统一使用英文 `README.md` 和中文 `README.zh-CN.md`。原来的 `README.en.md` 和 `docs/index.en.md` 地址保留为新版英文入口链接。
- 根目录 `NOTICE.md` 为英文，中文版为 `NOTICE.zh-CN.md`。`CONTRIBUTING.md`、`SECURITY.md` 为英文，中文版放在 `docs/contributing.zh-CN.md` 和 `docs/security.zh-CN.md`。其他配对指南沿用 `name.md`（中文）/ `name.en.md`（英文）。
- 修改启动命令、前置条件、数据或权限说明时同步两种语言，顶部保留互相切换和返回导航的链接。
- 增加语言时使用明确后缀（例如 `.ja.md`），在首页与文档索引登记已经完成的页面；未翻译内容标明原语言，不提供空页面或把中文链接标作英文。
- 文档使用相对链接，不写死某个 GitHub 仓库地址或私有开发分支，便于 Fork 和源码包复用。

## 自动化模板目录并发保护

GET `/api/admin/automation-templates` 返回 `items` 和不透明的 `revision`。PUT 必须携带两者；缺少版本返回 428，旧版本返回 409，不覆盖目录。管理界面与后端应同步部署，并刷新旧页面。遇到冲突时保留草稿，加载最新目录、核对其他管理员的修改后再明确保存；已删除模板不会静默重建。内部维护调用方必须先读取当前目录再修改。
