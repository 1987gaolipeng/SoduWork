# SoduWork

**简体中文** · [English](docs/README.en.md)

面向团队的 AI 工作平台：在桌面客户端中对话、协作和执行任务，在浏览器中管理成员、模型和执行环境。项目自有代码由 MDiRi 按 [MIT 许可证](LICENSE)授权，首版提供源码。

[快速上手](docs/getting-started.md) · [开发指南](docs/development.md) · [全部文档](docs/README.md) · [参与贡献](CONTRIBUTING.md)

## 先运行起来

1. 安装 [Python 3.12+](https://www.python.org/downloads/) 和 [Node.js 22.19+](https://nodejs.org/)，下载并解压源码。
2. 在源码根目录选择对应入口，首次按提示设置至少 12 个字符的管理员密码：

   | 系统 | 启动本地服务和桌面客户端 |
   | --- | --- |
   | Windows | 双击 `start-desktop.cmd` |
   | macOS | 双击 `start-desktop.command`；必要时先执行 `chmod +x start*.command start.sh` |
   | Linux 桌面 | 执行 `sh start.sh --desktop` |
   | 终端 | 执行 `python start.py --desktop`；macOS / Linux 通常使用 `python3` |

3. 等待依赖安装和页面构建完成，用 `admin` 和刚设置的密码登录。在 **http://127.0.0.1:18989** 配置自己的模型服务及所需 Agent。

首次需要联网，无需预先安装数据库或编写 `.env`。源码不含模型密钥或额度。数据保存在源码外的私有目录，服务默认仅本机可访问。保持启动终端打开；按 Ctrl+C 或退出桌面应用结束本次会话。

只使用管理页面：`python start.py`。先检查环境：`python start.py --check --desktop`。数据位置、准备模式和故障处理见[完整启动指南](docs/getting-started.md)；团队部署见 [Docker 自托管](ops/self-host/README.md)。

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
