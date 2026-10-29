# 从源码启动 SoduWork

**简体中文** · [English](getting-started.en.md) · [文档导航](README.md) · [开发指南](development.md)

这个入口用于在一台电脑上体验完整的管理服务和管理页面。它使用独立 SQLite 数据库，仅监听本机，不会修改已运行的服务。它不是公网、多实例生产部署入口。

## 一键打开桌面客户端

安装 Python 3.12+ 和 Node.js 22.19+ 后，使用以下入口可一次准备并启动本地服务、管理页面和桌面客户端：

| 系统 | 操作 |
| --- | --- |
| Windows | 双击源码根目录的 `start-desktop.cmd` |
| macOS | 双击 `start-desktop.command`；若解压丢失权限，先在源码目录运行 `chmod +x start*.command start.sh` |
| Linux 桌面 | 在源码目录运行 `sh start.sh --desktop`；需要已登录图形桌面和 Electron 所需系统库 |
| 任意系统终端 | `python start.py --desktop`；macOS / Linux 通常使用 `python3` |

首次设置管理员密码后，等待依赖安装和管理页面构建完成。客户端打开时使用 `admin` 和该密码登录。管理页面地址为 `http://127.0.0.1:18989`。在管理页面配置自己的模型服务，再按需安装执行底座；这不包含免费模型服务或默认 API Key。

桌面客户端使用该本地实例自己的 `desktop-profile/`，不会覆盖已安装客户端的账号、团队服务或个人历史。修改 `--port` 后，它自动连接本次启动的地址。该专用配置每次启动都连接本地实例；需要连接团队服务时，使用单独启动的客户端。桌面窗口关闭后应用可能仍在托盘运行，选择“退出”或在启动终端按 Ctrl+C 才会结束本次本地会话。

可先执行 `python start.py --check --desktop`，只检查前置环境，不安装依赖、不创建数据。也可执行 `python start.py --prepare-only --desktop`，提前安装依赖并构建管理页面，不启动服务、不要求管理员密码；之后去掉 `--prepare-only` 启动。两个入口都支持 `--data-dir`，准备与启动应使用同一个目录。

Linux 无图形桌面的服务器请省略 `--desktop`；启动器不会自动修改系统包或关闭 Electron 沙箱。若缺少 `libnss3`、GTK、X11/Wayland 等运行库，按发行版安装对应桌面依赖后重试，具体错误见 `desktop.log`。

## 首次启动

1. 安装 [Python 3.12 或更新版本](https://www.python.org/downloads/) 和 [Node.js 22.19 LTS 或更新版本](https://nodejs.org/)。Windows 安装 Python 时勾选 **Add Python to PATH**。
2. 下载并解压源码，或者克隆仓库。在源码根目录运行：

   ```sh
   python start.py
   ```

   macOS / Linux 也可运行 `./start.sh` 或 `python3 start.py`。macOS 可双击根目录的 **start.command**；若解压工具丢失执行权限，先运行 `chmod +x start.command start.sh`。Windows 可直接双击 **start.cmd**，优先使用已安装的 Python 3.12。

3. 首次运行时设置管理员密码，至少 12 个字符；默认账号名为 `admin`。密码输入时不会显示，不提供共享默认密码。脚本不保存管理员明文密码。
4. 启动器自动建立私有 Python 环境、安装服务端依赖、构建管理页面、执行数据库迁移并初始化管理员。首次需要联网；每个阶段都会显示提示，详情写入数据目录中的 `startup.log`。依赖和构建结果会复用，后续启动无需重复下载。
5. 准备完成后自动打开 **http://127.0.0.1:18989**。保持启动窗口打开；按 **Ctrl+C** 停止本次服务，数据会保留。

此入口不会自动安装 OpenCode 或其他可选智能体，也不含模型密钥。进入管理页面后，在模型管理中配置自己有权使用的模型服务；本机执行或云端执行仍需对应的 Agent、模型和执行环境。没有配置这些内容时，可以正常使用管理页面和协作数据功能，但不会自动获得 AI 推理能力。

## 连接桌面客户端

不带 `--desktop` 时只启动管理服务和管理页面。

上节带 `--desktop` 的联动入口会自动准备并打开桌面端；本节介绍需要独立启动、调试或连接团队服务时的手动方式。

从桌面源码启动时，在 `client` 目录先运行 `npm ci`，再运行 `npm start`；三种桌面系统共用同一入口。启动器清理继承的 Electron/Chromium 进程环境，保留已有服务连接、用户目录和代理设置。Windows 仍可使用 `client/start-soduwork.bat`。本节的源码服务入口和桌面入口需分别启动。

开发管理页面时，`hub-frontend` 的 Vite 代理默认连接 `http://127.0.0.1:9080`；通过环境变量 `SODUWORK_DEV_HUB` 指定其他后端，例如源码服务的 `http://127.0.0.1:18989`。代理同时覆盖 API、健康和就绪检查。

桌面客户端首次打开默认连接 `http://127.0.0.1:18989`，与这个启动器一致。服务启动后，使用已创建的账号登录。独立源码客户端可在登录页的「服务连接 · 更改地址」填写自己的 Hub 地址；联动启动器的专用客户端按本次启动地址连接，修改端口时重新运行启动命令即可。通用设置页不提供服务环境切换。使用其他端口时填写对应地址，例如 `http://127.0.0.1:18990`。连接远程团队服务时建议使用 HTTPS，不要在地址中填写账号、密码或 `/api` 路径。

升级已有客户端会保留原来选择的地址和每个服务的设备身份、登录资料与本机数据，不会把已有团队用户切换到本机。切换到另一台服务时需要使用那台服务的账号；原服务的数据不会自动上传或迁移。客户端本身不会替你启动 Hub，需要保持服务运行。本节是一条源码启动路径，首次构建仍需要前述 Python、Node.js 和网络条件。

`127.0.0.1` 只表示当前电脑。这个体验入口不对其他电脑开放；团队部署应使用 PostgreSQL、独立域名和 HTTPS，并按生产部署文档配置身份与备份。

单机部署入口是根目录 `python ops/self-host/deploy.py up`，使用 Docker Compose 和 PostgreSQL，与本节的本机 SQLite 体验分别管理数据。先阅读 [自部署指南](../ops/self-host/README.md)，团队访问仍需自己的 HTTPS 反向代理；本地脚本检查不代表 Docker 实机部署已验收。

## 数据放在哪里

| 系统 | 默认数据目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\SoduWork\source-service` |
| macOS | `~/Library/Application Support/SoduWork/source-service` |
| Linux | `$XDG_DATA_HOME/soduwork/source-service`，未设置时为 `~/.local/share/soduwork/source-service` |

已有源码服务若仍使用历史 `SoduWork/source-service` 或 `soduwork/source-service` 目录，且当前新目录尚未建立，启动器继续原位使用已有实例，不复制或重置其数据。

也可以明确指定独立目录和端口：

```sh
python start.py --data-dir "D:/SoduWork-local" --port 18990
```

目录必须位于源码目录之外，并且为空，或者已由这个启动器初始化。它不会采用源码目录中的 `.env`、数据库、个人 Agent 配置和生产环境变量。

- `soduwork.db`：用户、需求、任务、配置等业务记录。
- `local-service.json`：初始化账号名与随机生成的服务签名密钥。**请按私密配置保管**；它不包含管理员明文密码。删除或替换密钥会使已有登录失效。
- `library/`、`application/hub-backend/uploads/`：资料库和任务附件。
- `runtime/`、`home/`：此实例专用的运行目录与 Agent 配置。
- `venv/`、`application/`：独立依赖与从当前源码同步的运行副本。不要直接编辑这里的代码，业务附件应通过产品管理。
- `startup.log`：依赖安装、构建、迁移与服务器日志。
- `desktop.log`、`desktop-profile/`：联动桌面客户端的日志与独立账号、会话配置；这些同样属于私密数据，不应提交到源码仓库。

更新源码后停止并重新运行同一条命令即可，启动器只更新自己的代码副本并保留数据。更新前应在服务停止时备份**整个数据目录**；回退时同时恢复匹配版本的源码和数据备份，不能只降低源码版本。

## 常见问题

- **端口已占用**：启动器会报错并保留原进程，使用 `--port 18990` 等空闲端口重试。
- **安装或构建失败**：打开提示中的 `startup.log` 查看具体原因，检查网络/代理后原命令重试，已经完成的步骤会复用。不会悄悄跳过失败步骤启动残缺界面。
- **桌面端打不开**：检查 `desktop.log`；安装阶段提示 Electron 缺失时，检查 npm 是否禁止安装脚本及 Electron 下载是否被代理拦截。修正后重复原命令；也可先不带 `--desktop` 使用管理页面。管理页面本身不代替桌面的 AI 对话工作区。
- **系统里有 Python，仍提示版本太旧**：重新打开终端后运行 `python --version`（macOS / Linux 为 `python3 --version`）。Unix 入口还会寻找 `python3.12`、`python3.13`、`python3.14`，避免旧系统 Python 遮挡已安装的新版本。
- **自动化调用 Windows 入口**：设置 `SODUWORK_NO_PAUSE=1` 可在失败时直接返回错误码，避免等待按键；它不改变错误处理或密码规则。
- **第一次设置密码时输入错误或中途停止**：重新启动即可继续创建账号；账号已经创建后不会再次要求初始化密码或重置账号。
- **窗口关闭后打不开页面**：服务随启动器一起停止，重新运行即可。需要持续后台运行时使用正式部署方案。
- **已有目录不能使用**：请选择新目录；启动器不会覆盖不属于自己的文件。
- **忘记密码**：不要删除数据库以重新初始化。保留数据并通过正式的管理员密码恢复流程处理。

## 开发者验证

快速检查隔离、失败恢复、端口占用和密码处理：

```sh
python -m unittest tools.dev.test_start_local
```

真实隔离启动验证（会在临时目录安装依赖、构建管理端、创建数据库和做 HTTP 检查，需要网络）：

```sh
python tools/dev/verify_local_start.py
```

在有图形桌面的系统上加 `--desktop`，可同时验证原生 Electron 启动、专用服务地址，以及 Ctrl+C / 关闭启动器后的桌面进程清理。

该验证不使用已有 `.venv`、前端 `node_modules/dist`、业务数据库或默认端口 9080，不调用付费模型；不会把接口夹具测试声称为真实模型交付验证。

桌面客户端的首次连接与切换回归，在 `client` 目录运行 `node e2e/hub-connection.cjs`。它使用独立 Electron 配置目录、操作系统加密存储与两个临时 HTTP 服务，验证离线修改地址、登录、切换后身份隔离、回到原服务和重开窗口。截图和回执在 `outputs/hub-connection/`；不连接原有后台或调用模型。这项检查也已加入 `npm run test:e2e:local`。
