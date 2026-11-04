# SoduWork

**简体中文** · [English](docs/README.en.md)

面向团队的 AI 工作平台：在桌面客户端中对话、协作和执行任务，在浏览器中管理成员、模型和执行环境。项目自有代码由 MDiRi 按 [MIT 许可证](LICENSE)授权，首版提供源码。

[快速上手](docs/getting-started.md) · [开发指南](docs/development.md) · [全部文档](docs/README.md) · [参与贡献](CONTRIBUTING.md)

## 第一次使用：照着这 4 步做

**你会得到两个界面：桌面端用来对话和做任务，浏览器管理端用来配置模型和成员。** 同一个启动文件会把本地服务和两个界面一起准备好。

### 1. 安装两个软件（只做一次）

- [Python 3.12 或更新版本](https://www.python.org/downloads/)：Windows 安装时勾选 **Add Python to PATH**。
- [Node.js 22.19 或更新版本](https://nodejs.org/)：安装时保留默认选项，包括 npm。

安装后关闭旧终端。无需安装数据库、Docker、Git、Android Studio，也不用创建 `.env` 或在根目录运行 `npm install`。

### 2. 解压源码，打开启动文件

下载本项目的源码 ZIP，**先全部解压**到自己有写入权限的普通文件夹。打开能同时看到 `README.md`、`start.py`、`client` 的这一层目录，不要在压缩包里直接双击。

| 你的电脑 | 只做这一项 |
| --- | --- |
| **Windows** | 双击 **`start-desktop.cmd`** |
| **macOS** | 双击 **`start-desktop.command`**；若提示没有执行权限，见[macOS 启动说明](docs/getting-started.md#macos-打不开启动文件) |
| **Linux 桌面** | 在该目录打开终端，执行 `sh start.sh --desktop` |

### 3. 设置密码，等它完成

首次按提示为账号 **`admin`** 设置一个 **12–128 个字符**的密码，再输入一次。**输入时不显示字符或星号，这是正常的。** 请记住自己的密码；没有统一默认密码。

随后自动下载依赖、构建页面并启动服务。首次可能需要数分钟，取决于网络和电脑性能；长步骤每隔约 15 秒会提示仍在进行。保持窗口打开，不要重复双击。失败后按提示修正，再运行同一个文件即可，已经完成的步骤会复用。

### 4. 登录，开始使用

看到 **`SoduWork is ready` / `启动成功`**，浏览器和桌面端会陆续打开。

- **管理端**：[打开本机管理页面](http://127.0.0.1:18989)。首页点击 **「进入管理后台」**，用 `admin` 和刚才的密码登录。无需在首页再下载客户端。
- **桌面端**：用同一账号密码登录。启动器已经替它设置好本地服务地址。
- **想开始 AI 对话**：先在管理端 **「能力配置 → 模型目录」**接入自己的模型服务，再回桌面端选择模型。[按字段配置并发出第一条消息](docs/getting-started.md#发出第一条-ai-消息)。不接模型也能先登录查看界面；源码不附带模型密钥或额度。

**下次使用：还是双击同一个启动文件，用原账号密码登录。** 停止时在启动终端按 **Ctrl+C**；关闭桌面窗口可能只是最小化到托盘。数据会保留，也不会覆盖已安装正式客户端的账号和历史。

遇到问题先看[常见问题与可复制命令](docs/getting-started.md#常见问题)。只需要浏览器管理端、想换端口、查看数据位置或开发调试，也都在[完整启动指南](docs/getting-started.md)里。团队部署另见 [Docker 自托管](ops/self-host/README.md)。

## 理解项目结构

```text
桌面客户端 client/ ──────┐
                        ├── HTTP / WebSocket ── Hub 服务 hub-backend/ ── 数据库
管理页面 hub-frontend/ ──┘                            │
                                            本地或独立 Runner → Agent / 模型
```

| 位置 | 职责 | 从哪里开始 |
| --- | --- | --- |
| `client/` | Electron 桌面、对话和本机执行入口 | [客户端说明](client/README.md) |
| `hub-backend/` | FastAPI 接口、权限、数据、任务编排与 Runner 源码 | [后端说明](hub-backend/README.md) |
| `hub-frontend/` | React + Vite 管理页面 | [管理端说明](hub-frontend/README.md) |
| `skills/` | 本项目自有的办公、任务和扩展指南 | [插件开发协议](docs/plugin-authoring.md) |
| `ops/self-host/` | 单机 Docker 部署与配置 | [自托管说明](ops/self-host/README.md) |
| `tools/` | 本地启动、质量检查和源码导出 | [开发与验证](docs/development.md) |
| `third-party/` | 第三方许可与来源记录 | [依赖声明](NOTICE.md) |
| `docs/` | 使用、开发和分发文档 | [文档导航](docs/README.md) |
| `.github/` | 自动验证、依赖更新与双语协作模板 | [GitHub 配置说明](.github/README.md) |

三个工程各自维护依赖；根目录不需要运行 `npm install`。[开发指南](docs/development.md)按“改页面、改接口、改桌面、改扩展”说明修改位置、开发方式和验证命令。

## 第三方开源组件

感谢以下开源项目及其贡献者：

- 桌面与管理界面：Electron、React、Vite。
- 服务与 Agent 执行：FastAPI、Pi SDK、Google Research Harness²。
- 编辑、终端与内容渲染：CodeMirror、xterm.js、marked、highlight.js、jsdiff、diff2html、DOMPurify。

第三方组件遵循各自的原始许可证，保留其版权和许可声明；项目的 MIT 许可证适用于项目有权授权的自有内容。以上仅列举主要组件，具体版本、来源与许可原文见[第三方声明](NOTICE.md)、[许可与来源记录](third-party/README.md)及[依赖材料清单](third-party/manifest.json)。

源码与最终安装包的组件范围可能不同。安装包公开分发前仍需补齐原始许可、对应源码归档及各平台最终清单，当前状态见[待完成的分发材料](third-party/README.md#二进制发行尚需完成)。

## 公开范围与贡献

首版保留桌面、Hub、管理端、Runner、自有技能和通用部署工具；移除移动端、第三方技能套件、内部设计与公司专用运维材料。通用模型 API 与 Codex 等执行器的兼容代码使用用户自己的服务和权限。详见[首版范围](docs/release-scope.md)。

提交前按[贡献指南](CONTRIBUTING.md)完成相关检查；安全问题请走[私密报告渠道](SECURITY.md)。源码清单通过不代表安装包、容器或所有平台均已验收。

维护者准备公开仓库时，使用[源码分发流程](docs/open-source.md)导出已提交、经清单核对的文件树；公开仓库不应继承私有开发历史或旧标签。

[MIT 许可证](LICENSE) · [第三方声明](NOTICE.md) · [English documentation](docs/index.en.md)
