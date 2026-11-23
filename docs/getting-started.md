# 从零运行 SoduWork

**简体中文** · [English](getting-started.en.md) · [返回 README](../README.zh-CN.md) · [开发指南](development.md)

命令示例中的 `sh start.sh` 适用于 macOS/Linux；Windows PowerShell 使用 `.\start.cmd`，命令提示符使用 `start.cmd`，参数相同。独立 Python 工具示例使用 `python3`；Windows 使用 `py`，已激活虚拟环境时使用 `python`。

第一次使用只需要走完「装环境 → 解压 → 启动 → 登录」。这个入口在当前电脑运行 Hub（后台服务）、浏览器管理端和桌面客户端，使用独立 SQLite 数据库。没有服务器也可以体验。

## 装环境、解压、启动

1. 安装 [Python 3.12+](https://www.python.org/downloads/) 和 [Node.js 22.19+](https://nodejs.org/)。Windows 安装 Python 时勾选 **Add Python to PATH**；Node 安装保留默认选项及 npm。安装完成后关掉旧终端。
2. 下载源码 ZIP，选择「全部解压」。建议放到自己有写入权限的普通目录，例如 `C:/SoduWork`；不要放进系统程序目录，也不要在 ZIP 里直接运行。
3. 打开包含 `README.md`、`start.py`、`client` 的目录，按系统启动：

   | 系统 | 默认入口 |
   | --- | --- |
   | Windows | 双击 `start-desktop.cmd` |
   | macOS | 双击 `start-desktop.command` |
   | Linux 图形桌面 | 在该目录打开终端，运行 `sh start.sh --desktop` |

4. 保持窗口打开，等待启动器安装依赖、构建管理页面并准备桌面运行环境。首次下载可能需要几分钟，耗时较长的步骤每隔约 15 秒显示进度。如果准备失败，请查看窗口给出的 `startup.log`，排除故障后重新运行同一条命令。
5. 准备成功后，为账号 **`admin`** 设置 **12–128 个字符**的密码，再输入一次确认。输入时不会显示字符或星号，每次输完按回车。输错会提示重新输入。随后启动器初始化数据库并打开客户端。账号创建成功后，后续启动沿用这个密码。

不需要手动创建数据库、安装 Docker、安装 Git、准备 `.env` 或分别运行三个工程的安装命令。首次需联网下载依赖，后续复用已安装内容。

启动器会在专用 `venv/` 中安装 Hub 和 Runner 两套依赖，检查 Runner 所需的 Python 模块，并把同一解释器交给桌面端。使用此入口无需另建 `hub-backend/.venv`。如果 Agent 管理提示源码 Runner 环境不完整，请退出源码启动会话后重跑同一入口，保留原数据目录。

服务端和桌面端准备期间，npm、pip 和 Electron 下载缓存默认分别写入数据目录下的 `cache/npm`、`cache/pip` 和 `cache/electron`。非空的 `npm_config_cache`、`PIP_CACHE_DIR` 和 `electron_config_cache` 设置会保留其显式指定的位置，这些位置可以在数据目录之外。所有平台的准备流程还会创建 `cache/tmp`，并为子进程设置 `TMPDIR`、`TEMP` 和 `TMP`，让下载、解包和构建使用所选磁盘，不再沿用系统临时目录；当前终端的环境变量不变。停止启动器后，备份或迁移时可以跳过可再生的 `cache/`。

Windows 桌面启动还会在本实例的应用副本中准备并校验命令运行环境（PortableGit），供 Agent 使用 Bash、Git 和常用命令。无需单独安装 Git 或配置 WSL。后续启动会保留运行环境和下载缓存，并再次检查可用性；准备失败时查看 `startup.log`，解决日志报告的问题后重跑同一入口。

## 怎么判断启动成功

终端会出现以下关键信息（地址以实际输出为准）：

```text
SoduWork is ready: http://127.0.0.1:18989
Administrator: admin
启动成功！管理页面：http://127.0.0.1:18989
```

随后出现浏览器页面和桌面客户端：

- 浏览器默认先显示介绍首页，点击 **「进入管理后台」**才是登录页面；无需在首页再下载客户端。
- 两个界面都用 **`admin` + 自己刚设置的密码**。这是本地实例的账号，不是线上服务账号；不需要额外注册。
- 浏览器没有自动打开时，手动访问 [http://127.0.0.1:18989](http://127.0.0.1:18989)。更换端口后使用终端打印的新地址。
- 联动桌面客户端已经连接本次启动的本地服务，使用独立的桌面配置目录。本机已有的正式客户端账号、服务地址和历史不会被覆盖。

首次启动完成只表示工程可以使用。要让 AI 回答，还需要配置自己的模型服务。

## 发出第一条 AI 消息

已经保存 API Key 时，从第 3 步继续：还需添加具体的对话模型，再回到桌面端选择 Pi 和这个模型。浏览器管理端完成配置，桌面端发起对话；两端必须连接同一个 Hub。

先准备模型服务商提供的 **接口地址、API Key、模型 ID**。这些是服务商给你的资料，不能用本地管理员密码代替。真实模型调用可能产生服务商费用。

1. 在浏览器登录管理端，打开 **「能力配置 → 模型目录」**，点 **「接一个服务」**。
2. 按下表填写并保存：

   | 字段 | 怎么填 |
   | --- | --- |
   | 标识 | 自己起一个英文标识，例如 `my-provider` |
   | 名字 | 自己看得懂的名称，例如「我的模型服务」 |
   | 协议 | 按服务商说明选择；只有支持 OpenAI 兼容接口时才选「OpenAI 兼容」 |
   | 接口地址 | 服务商提供的基础地址；OpenAI 兼容服务通常包含 `/v1`，不要把完整 `/chat/completions` 路径填进来 |
   | API Key | 自己的服务密钥；仅在服务确实不需要鉴权时留空 |

3. 在该服务卡片点 **「加模型」**，填写服务商给出的准确模型 ID，选择 **「对话模型」**并保存。自定义显示名称不等于模型 ID。
4. 回到桌面端，打开新对话，选择一个**已就绪的执行底座**和刚添加的模型。若界面提示底座未安装或未登录，按提示完成该底座的准备，再继续。第一次不用接远程电脑或部署云端 Runner。
5. 输入「你好，请用一句话介绍你能做什么」。能收到真实回复，才表示这条 AI 链路已接通。

看不到刚添加的模型时，刷新模型目录或重新打开桌面端的模型选择器；仍为空时，核对两端连接的服务地址是否一致。`401/403` 通常需检查模型密钥及访问权限，`404` 需检查接口地址、模型 ID 和协议。没有模型服务时，可以先使用管理页面，稍后再接入。

### 仅保存在本机的模型服务

在桌面端「我的模型」中添加的本地服务会加密保存在该桌面配置目录中，接口地址、密钥、模型引用和本地用量不会上传到 Hub。请在本机 Pi 对话中选择使用；云端执行、会话交接、定时任务和后台默认模型需要选择 Hub 托管模型。本地图片、视频模型定义仍会保留，但不会进入 Hub 媒体代理的可选列表。

使用桌面客户端仍需登录，既有会话和需求权限继续生效。登录后，Hub 的模型管理和模型额度不控制本机 Pi 使用的本地模型，客户端直接请求其服务商。普通会话目录继续同步，但不携带模型配置、模型引用或本地用量。

本地模型选择和运行记录使用随机模型引用；真实模型 ID、显示名称、接口地址及凭据的对应关系保存在本地加密目录中，运行配置文件使用占位值。已有结构化本地引用会迁移，不改写消息正文或已被 Hub 确认的历史用量。删除后重新添加模型，不会让旧会话自动关联到新模型。这项保护不加密聊天正文或用户生成的文件，也不会清除外部备份中的副本。

安全存储无法读取时，客户端会保留已有配置并提示修复存储问题。无效编辑会被拒绝，不会覆盖原配置。本地模型和托管模型之间切换时，每次调用的用量分别处理。

### 切换账号后的会话历史

最近会话、本机历史和归档默认只显示当前账号在当前 Hub 下的记录。切换账号或服务不会删除原档；切回原账号和原服务即可查看有完整归属记录的历史。短期登录凭据过期时，已验证的本机归属仍可用于离线查看；明确退出登录后不再显示该账号的历史。

没有归属记录的旧 Pi 会话，可在桌面端**归档 → 导入旧 Pi 会话**中选择本机索引内的 JSONL 文件，并确认导入为当前账号的只读副本。原文件保留，工具权限和执行状态不会恢复。当前只支持能够完整读取的 Pi 格式，最多 32 MiB、10,000 条消息；不支持的消息或附件格式会拒绝导入，避免静默丢失内容。已有其他账号归属或冲突记录不能通过此入口导入。

部分旧档只记录了账号、没有可验证的原服务信息，会被暂时隐藏；原文件仍保留，直接打开或尝试导入时会说明归属限制。这类记录需要补充可信的原服务证据，目前不能用“导入旧 Pi 会话”接管，请保留桌面配置备份，不要删除或手工改写归属记录。

## 第二次启动和退出

- 下次仍双击原启动文件，用原账号密码登录；数据和已配置的模型会保留。
- 退出时在启动终端按 **Ctrl+C**，等待停止提示。桌面窗口的关闭按钮可能只收进托盘，需要在托盘选择「退出」才能结束应用。
- 不要重复双击；提示实例已运行时，使用已打开的启动窗口和页面。
- 更新源码前停止服务、备份整个数据目录及单独存放的桌面配置目录；再更新源码并运行同一入口。不要直接修改数据目录里的应用副本。

## 常见问题

### Windows 双击没有正常启动

先看窗口最后几行。提示找不到 Python 或 Node 时，安装上面的对应软件并重新打开启动文件。窗口会在失败时保留错误，不必反复双击。

若窗口仍一闪而过，在源码文件夹空白处右键，选择「在终端中打开」，运行：

```powershell
.\start-desktop.cmd
```

只检查环境，不安装任何依赖：

```powershell
.\start.cmd --check --desktop
```

`--check` 只读检查依赖和路径风险，不创建探测文件；检查通过不代表后续所有安装步骤都一定成功。随后在 PowerShell 中运行 `.\start.cmd --desktop`；在命令提示符（CMD）中运行 `start.cmd --desktop`。两种终端都可使用，不需要避开 CMD。

路径诊断采用中英双语。重定向输出时保留当前编码；无法表示的字符使用转义形式，避免中断启动，英文处理说明仍然可读。

Git Bash 中的 `sh start.sh --desktop` 并非无效命令，但它通过 `PATH` 查找 Python，与 Windows 入口的选择方式不同。`start.cmd` 在有 Python 启动器 `py` 时先尝试 Python 3.12，再尝试 `py -3`；没有 `py` 时才使用 `PATH` 中的 `python`。安装了 Python 3.13 等受支持版本，不代表两个终端会选中同一个解释器。

提示 Python 版本过低或找不到解释器时，先在原终端查看 `python --version`；装有 `py` 时再查看 `py -0p` 列出的版本和路径。必要时用已安装的原生 Windows Python 3.12+ 的完整路径检查，检查通过后用相同解释器启动（替换示例路径）：

```powershell
& 'C:\Path\To\Python\python.exe' .\start.py --check --desktop
& 'C:\Path\To\Python\python.exe' .\start.py --desktop
```

Microsoft Store 版 Python 是有效的解释器，但 Windows 可能将其数据目录重定向到更深的物理路径。需要长路径时，正式启动会在复制源码、创建虚拟环境和安装依赖之前，通过实际文件操作检查路径是否可用。Windows 的传统 260 字符路径限制不适用于 macOS 和 Linux。

如果启动时提示无法使用长路径，请在 Windows 中启用 **Win32 长路径**，然后重新打开启动程序，使其使用新进程。启动器不会修改这个系统设置。已有数据请保留在原目录；较短的 `--data-dir` 可用于**新建独立实例**，不会迁移原有账号或数据。

### macOS 打不开启动文件

打开终端，输入 `cd `（末尾留一个空格），把解压后的源码文件夹拖进终端，再按回车。然后执行：

```sh
chmod +x start.command start-desktop.command start.sh
sh start.sh --desktop
```

不需要 `sudo`。Linux 桌面也可直接使用最后一条命令；没有图形桌面的 Linux 服务器改用 `sh start.sh`。

### 密码输入后屏幕没有变化

密码不显示字符或星号是正常的，输入完按回车。短于 12 个字符或两次不一致时会重新提示。账号是 `admin`；没有共享默认密码。忘记已有密码时不要删数据库，以免丢失数据。

### 首次设置密码时提示标准输入不是终端

未初始化的实例需要设置管理员密码；默认方式要求 Python 将标准输入识别为交互终端（TTY）。Git Bash 窗口可见，并不保证原生 Windows Python 会将它识别为 TTY；管道、重定向或某些集成终端也可能触发此检查。这与密码输入不显示字符是两种情况。

先在原生 PowerShell 或 CMD 的交互窗口中，从源码目录运行 Windows 入口，不加管道或输入重定向。自动化或确实需要非交互输入时，显式添加 `--password-stdin`，通过受保护的标准输入提供首次密码；该参数不会自动生成密码，也不用于重置已有密码。不要把密码写进命令参数、脚本或日志。保留现有数据目录，无需删除数据库重试。对于首次冷启动安装且依赖下载耗时较长的自动化场景，建议先运行 `--prepare-only` 下载依赖与构建界面，再沿用相同的数据目录和桌面选项，使用 `--password-stdin` 启动，以避免输入管道在长耗时安装过程中被环境提前关闭。

### 安装很慢、失败或提示网络错误

长步骤的「Still running」表示安装进程尚未结束，并不代表下载已经成功。重试前先查看终端打印的 `startup.log` 中失败的步骤。提示「磁盘空间不足 / Disk full」时，应释放数据目录或显式指定缓存所在磁盘的空间；重复下载不会释放空间。依赖版本不存在、权限不足等错误也需要分别处理，仅在日志报告连接失败时检查网络、代理及包下载访问。修正后重跑同一入口，已完成的步骤会复用。不要删除数据目录。首次 Electron 下载也需要联网。

npm 注册表与二进制下载使用不同的地址。设置 npm 镜像只改变 npm 包的来源，不会同时改变 Electron 或 PortableGit 的下载地址：

| 下载内容 | 对应设置 |
| --- | --- |
| npm 包 | `npm_config_registry` 或 npm 的 `registry` 配置 |
| Electron 二进制 | `ELECTRON_MIRROR`，见下面的桌面启动排障 |
| Windows PortableGit 归档 | `SODUWORK_PORTABLE_GIT_MIRROR`，见下面的镜像与离线说明 |

#### Git 克隆或依赖下载出现证书错误

先区分失败发生在哪一步：

- **`git clone` 报 schannel `0x80092012` / 撤销检查失败**：这是 Git 获取源码时的证书撤销检查问题，发生在启动器运行之前。核对系统时间、可信证书链、代理及证书撤销服务的可达性；受管理的网络应请管理员确认代理证书与访问策略。切换 `sh` / `cmd` 启动入口不能修复克隆失败。不建议设置全局 `http.schannelCheckRevoke=false`，它会关闭撤销检查并影响后续 Git 请求。
- **Electron 或 PortableGit 下载报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 等证书链错误**：检查对应下载地址及代理提供的证书链。企业 TLS 代理需要由管理员提供可信 CA，并按所用 Git / Node 下载工具的方式配置信任；Git 的证书配置不等于 Node 的配置。不要用 `NODE_TLS_REJECT_UNAUTHORIZED=0` 绕过校验；即使某个归档有固定摘要，也不能保护同一安装过程中所有请求。
- **只看到 `TypeError: fetch failed`**：这是通用网络错误，不足以判断是 GitHub 不可达或证书问题。查看 `startup.log` 中同一失败步骤的底层错误（如 `cause.code`）及下载地址，再分别核查 DNS、代理、超时或 TLS。

网络受限时，按本节的代理说明、[PortableGit 镜像与离线归档](#windows-portablegit-镜像与离线归档)或[Electron 镜像说明](#浏览器能打开桌面端打不开)处理。镜像返回 `404` / `403` 时，先核对具体版本、架构、文件路径及访问权限，不要据此推断所有镜像都不可用。修正配置后保持证书校验开启，重新运行同一入口。

需要求助时，提供失败步骤、终端类型、Python / Node / Git 版本，以及相关错误和底层错误码；先移除日志中的密码、令牌、代理凭据和私有地址。

#### 使用代理下载

在启动源码的同一个终端设置代理，再运行入口。下面的 `7890` 只是示例端口，应改成你的 HTTP 代理实际监听端口。保留已有 `NO_PROXY` 规则，并让本地 Hub 地址绕过代理。

Windows PowerShell：

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:7890'
$env:HTTPS_PROXY = $env:HTTP_PROXY
$env:NO_PROXY = "$env:NO_PROXY,localhost,127.0.0.1,::1".TrimStart(',')
.\start.cmd --desktop
```

macOS/Linux：

```sh
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY="$HTTP_PROXY"
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}localhost,127.0.0.1,::1"
sh start.sh --desktop
```

启动器检测到 `HTTP_PROXY` 或 `HTTPS_PROXY` 时，会为 Electron 安装子进程自动启用 `ELECTRON_GET_USE_PROXY`。已有的显式设置会保留；设置为 `0`、`false`、`no`、`off` 或空值可关闭 Electron 的代理自动启用。Node 下载脚本按请求读取代理和 `NO_PROXY`，适用于上面要求的 Node.js 22.19+，无需提高最低版本。`ELECTRON_GET_USE_PROXY` 只控制 Electron，不控制 PortableGit 下载。

#### Windows PortableGit 镜像与离线归档

首次下载较慢时可以超过五分钟。安装包每新增 64 KiB，启动器就会重新计算五分钟时限。如果服务器连续 60 秒没有发送数据，下载会超时。可在 `startup.log` 查看已接收的字节数。

PortableGit 默认从官方 Git for Windows 发布地址下载。需要镜像时，设置 `SODUWORK_PORTABLE_GIT_MIRROR` 为镜像根地址，文件按 `<mirrorRoot>/v2.55.0.windows.4/<官方原文件名>` 提供。x64 文件名为 `PortableGit-2.55.0.4-64-bit.7z.exe`，arm64 为 `PortableGit-2.55.0.4-arm64.7z.exe`。请先确认镜像提供固定版本和当前架构的文件；项目不预设 PortableGit 镜像。

将下面的示例地址替换成自己可用的镜像地址：

```powershell
$env:SODUWORK_PORTABLE_GIT_MIRROR = 'https://mirror.example/portable-git'
.\start.cmd --desktop
```

下载会先尝试指定镜像，失败后回退官方地址。若只允许访问镜像，在启动前另外设置 `$env:SODUWORK_RUNTIME_MIRROR_ONLY = '1'`，禁止回退到官方源。镜像文件仍须通过项目固定的 SHA-256 校验，不能用其他版本替代。`ELECTRON_MIRROR` 仅用于 Electron，不会作为 Git 镜像。

也可以提前取得匹配版本、架构及摘要的官方归档，通过本地路径使用，例如 x64：

```powershell
$env:SODUWORK_PORTABLE_GIT_ARCHIVE = 'C:\Downloads\PortableGit-2.55.0.4-64-bit.7z.exe'
.\start.cmd --desktop
```

准备脚本只读取并校验该归档，不会改写、删除或重新下载覆盖它。文件不存在或 SHA-256 不匹配时会报错，请修正路径或重新取得正确归档后重试。这个离线设置只解决 PortableGit；其他尚未安装的依赖仍需要可用的下载来源。

### 提示端口已占用

不要结束不认识的进程。在源码目录的终端改用一个空闲端口，例如：

```powershell
# Windows
.\start-desktop.cmd --port 18990
```

```sh
# macOS / Linux
sh start.sh --desktop --port 18990
```

本次浏览器地址变为 `http://127.0.0.1:18990`，联动桌面端会自动使用新地址。若该端口也被占用，换另一个空闲端口。

### 浏览器能打开，桌面端打不开

Electron 二进制文件的下载有十分钟超时限制。超时后，按上面的代理说明配置，或为 Electron 单独指定能访问的镜像，再运行同一个启动命令。npm 注册表镜像不控制这次二进制下载。例如，按终端类型设置 Electron 镜像。

macOS/Linux：

```sh
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ sh start.sh --desktop
```

Windows PowerShell：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
.\start.cmd --desktop
```

Windows 命令提示符：

```bat
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
start.cmd --desktop
```

安装器会沿用已有 `ELECTRON_MIRROR` 和代理设置，并校验下载文件的摘要。这个镜像设置只影响 Electron，Windows PortableGit 需按上面的独立设置处理。慢速网络可将 `ELECTRON_DOWNLOAD_TIMEOUT` 设置为更大的秒数。下次启动会复用已安装成功的依赖。

查看同一数据目录中的 `desktop.log`。Electron 下载失败时先解决下载问题，再重试。Linux 桌面需要图形会话和 Electron 所需的系统库（如 NSS、GTK、X11/Wayland）；启动器不会关闭沙箱或自动修改系统包。

### Linux 安装与安全登录

使用发行版的软件安装器安装 `.deb` 或 `.rpm`，或通过 `apt install ./安装包.deb`、`dnf install ./安装包.rpm` 安装，让包管理器解析依赖。安装包声明 D-Bus、libsecret，以及 GNOME Keyring / KWallet 服务的替代依赖；已有匹配的服务可以满足依赖，不需要替换用户的密钥环。`tar.gz` 和源码模式不管理系统依赖，需要在图形桌面会话中启动。

请以当前登录桌面的普通用户启动应用。首次访问密钥环可能出现系统创建或解锁提示，应使用受保护的密钥环；不要设置空密码或通过关闭沙箱绕过启动错误。密钥环被锁定或服务暂不可用时，现有设备凭据应予保留，恢复系统服务后完全退出并重新打开应用。不要删除 `device-auth.json`、密钥环项目或把凭据改成明文。

如果当前配置还没有设备凭据，系统密钥环又不可用，可以在启动时选择本地加密凭据库，再照常登录。请另设一个 12–256 个字符的口令并妥善保存。以后每次启动桌面端都要输入它，安装密钥环后也一样。口令仅在本机使用，无法通过 Hub 找回。解锁后，若系统密钥环可用，「我的模型」里已有的本地服务凭据以及同一桌面配置中的本地 Agent 默认模型和自动化本地模型选择仍通过系统密钥环读写，不会改写为凭据库格式。只有在系统密钥环不可用或仅为 `basic_text` 时，解锁后的凭据库才会加密保存这些记录。已有的 `device-vault-v1` 不会被重置。没有启用这个本地凭据库时，这些数据仍只使用系统密钥环。应用凭据、飞书连接、插件发布私钥和云端电脑凭据在没有系统密钥环时仍然不可用。

源码启动器的 Linux 桌面模式会提前拒绝 root 用户（包括通过 `sudo` 启动），在创建实例数据或安装依赖前给出提示；`--check --desktop` 和 `--prepare-only --desktop` 也会执行此检查。请在普通用户的图形会话中运行 `sh start.sh --desktop`；服务器只需运行 `sh start.sh`。

Linux 安装验收先检查 `.deb` / `.rpm` 的首次安装是否已提供密钥服务依赖，再使用隔离的真实 GNOME 密钥环检查首次启动、重启和升级后的密文读取。当前升级场景复用首次安装的依赖，不证明旧环境升级时能自动补齐新增依赖；容器验收也不替代 GNOME/KDE、Wayland/X11 的真实桌面登录与解锁验证。

需要先看管理端时，Windows 双击 `start.cmd`，macOS 双击 `start.command`，Linux 运行 `sh start.sh`。浏览器管理端用于管理配置，不是桌面的 AI 对话工作区。

### macOS 钥匙串与桌面名称、图标

Git 提示 rebase 或 merge 尚未完成时，先完成该操作，或备份后安全中止，再启动客户端。中间状态可能暂时恢复旧启动脚本及其钥匙串、Electron 名称和图标问题。运行 `git status` 确认已回到预期分支，然后停止旧的源码启动进程，重新运行 `sh start.sh --desktop`；运行中的客户端会继续使用旧应用副本，直到重启。

macOS 桌面进程保留当前用户的系统主目录，以便访问默认钥匙串。应用数据和工作目录仍与已安装客户端分离，本地 Hub 仍使用隔离的主目录和数据库。

源码桌面启动会准备独立缓存的 `SoduWork.app`，使用产品名称和图标。开发配置目录继续独立保存，不修改已安装客户端或下载的 Electron 应用包。这个本地开发包使用临时签名，不等同于经过正式签名和公证的发布安装包。

默认 macOS 钥匙串缺失时，启动器会先显示恢复页面，再进入正常工作区。点击**打开钥匙串访问**，检查登录钥匙串与默认钥匙串设置，修复系统设置后退出并重新启动 SoduWork。拒绝或取消访问后，登录页会提示安全存储错误并保留已有凭据。SoduWork 不会重置钥匙串，也不会降级为明文存储。仅在 [Apple 支持](https://support.apple.com/guide/keychain-access/kyca2429/mac)指导下重置钥匙串。

### 关闭启动窗口后页面打不开

本地服务已停止。重新运行同一个启动文件即可，数据仍在。

## 按需使用的命令

在源码根目录执行。表格使用 macOS/Linux 的启动脚本；Windows PowerShell 使用 `.\start.cmd`，命令提示符使用 `start.cmd`，参数相同。

| 需要做什么 | 命令 |
| --- | --- |
| 联动启动（与双击桌面入口相同） | `sh start.sh --desktop` |
| 只启动浏览器管理端 | `sh start.sh` |
| 只检查环境 | `sh start.sh --check --desktop` |
| 提前下载和构建，暂不启动 | `sh start.sh --prepare-only --desktop` |
| 不自动打开浏览器 | `sh start.sh --desktop --no-browser` |
| 指定独立的数据目录 | `sh start.sh --desktop --data-dir "D:/SoduWork-data"` |

准备和启动应使用同一个数据目录。指定 `--password-stdin` 后，启动器只在准备成功后才从标准输入读取首次密码。请勿将密码写入命令参数或脚本。Windows 在此模式下失败会直接返回错误码。其他无人值守的启动命令可设置 `SODUWORK_NO_PAUSE=1` 跳过失败后的按键等待。

开发者需要分别调试前后端时，见[开发指南](development.md)。Vite 开发代理默认连接 `http://127.0.0.1:9080`，连接本启动器时使用 `SODUWORK_DEV_HUB=http://127.0.0.1:18989`。本指南默认只供当前电脑访问；团队部署见 [Docker 自托管](../ops/self-host/README.zh-CN.md)。

## 数据放在哪里

| 系统 | 默认数据目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\SoduWork\source-service` |
| macOS | `~/Library/Application Support/SoduWork/source-service` |
| Linux | `$XDG_DATA_HOME/soduwork/source-service`，未设置时为 `~/.local/share/soduwork/source-service` |

在 Windows 上，`LOCALAPPDATA` 为空或为相对路径时按未设置处理，回退到 `%USERPROFILE%\AppData\Local`。绝对路径形式的 `LOCALAPPDATA` 保持不变。所选数据目录仍须位于源码目录之外，并且为空或已由此启动器初始化。

在 Linux 上，`XDG_DATA_HOME` 未设置、为空或为相对路径时，回退到 `~/.local/share`。绝对路径（包括含空格的路径）保持不变，显式指定的 `--data-dir` 优先。已有数据不会迁移；如果之前使用相对 XDG 目录保存数据，可通过 `--data-dir` 指定其绝对路径继续使用。源码目录安全检查仍然生效。

也可以明确指定独立目录和端口：

```sh
sh start.sh --data-dir "D:/SoduWork-local" --port 18990
```

目录必须位于源码目录之外，并且为空，或者已由这个启动器初始化。它不会采用源码目录中的 `.env`、数据库、个人 Agent 配置和生产环境变量。

- `soduwork.db`：用户、需求、任务、配置等业务记录。
- `local-service.json`：初始化账号名与随机生成的服务签名密钥。**请按私密配置保管**；它不包含管理员明文密码。删除或替换密钥会使已有登录失效。
- `library/`、`application/hub-backend/uploads/`：资料库和任务附件。
- `runtime/`、`home/`：此实例专用的运行目录与 Agent 配置。
- `venv/`、`application/`：独立依赖与从当前源码同步的运行副本。不要直接编辑这里的代码，业务附件应通过产品管理。
- `startup.log`：依赖安装、构建、迁移与服务器日志。
- `desktop.log` 记录联动桌面客户端的日志。桌面账号和会话配置通常位于数据目录下的 `desktop-profile/`。在 macOS 上，若数据目录位于正式客户端的 `SoduWork/` 或 `soduwork/` 内，桌面配置使用 `SoduWork Development/` 下的独立目录。默认数据目录继续使用 `source-service-desktop`；自定义目录使用 `source-service-desktop-<目录标识>`，标识由完整数据路径生成。如果该目录尚不存在，会沿用通过安全检查的既有开发配置 `source-service-desktops/<目录标识>/`；两者都存在时优先标准目录。Hub 数据和账号留在原处，配置文件不会被移动或合并。启动器会在写入前拒绝指回正式客户端配置的输出链接；`--check --desktop` 只读打印所选桌面配置路径。桌面配置同样属于私密数据。

升级旧版 Hub 前，请确认至少有一个管理员账号的密码为 8–128 个字符，且包含非空白字符。旧账号的密码不符合此规则时，请在升级前重设，尤其是只有一位管理员的情况。已验证邮箱的用户也可以通过邮箱重置密码。通过启动器首次设置管理员密码时，长度要求为 12–128 个字符。

更新源码后停止并重新运行同一条命令即可，启动器只更新自己的代码副本并保留数据。更新前应在服务停止时备份**整个数据目录**及单独存放的桌面配置目录；回退时同时恢复匹配版本的源码和数据备份，不能只降低源码版本。

## 开发者验证

快速检查隔离、失败恢复、端口占用和密码处理：

```sh
python3 -m unittest tools.dev.test_start_local
```

真实隔离启动验证（会在临时目录安装依赖、构建管理端、创建数据库和做 HTTP 检查，需要网络）：

```sh
python3 tools/dev/verify_local_start.py
```

在有图形桌面的系统上加 `--desktop`，可同时验证原生 Electron 启动、专用服务地址，以及 Ctrl+C / 关闭启动器后的桌面进程清理。

macOS 可运行 `TMPDIR=/private/tmp python3 tools/dev/verify_source_runner.py`，要求 `PATH` 中有 Node.js 22，并使用已安装 `websockets` 的 Python 3.12+ 测试解释器。它创建临时 Hub、桌面配置和真实 Runner，以合成账号登录并检查 Agent 发现，不创建任务或调用模型。夹具使用 Chromium 模拟钥匙串，不验证原生钥匙串访问。

该验证不使用已有 `.venv`、前端 `node_modules/dist`、业务数据库或默认端口 9080，不调用付费模型；不会把接口夹具测试声称为真实模型交付验证。

桌面客户端的首次连接与切换回归，在 `client` 目录运行 `node e2e/hub-connection.cjs`。它使用独立 Electron 配置目录、操作系统加密存储与两个临时 HTTP 服务，验证离线修改地址、登录、切换后身份隔离、回到原服务和重开窗口。截图和回执在 `outputs/hub-connection/`；不连接原有后台或调用模型。这项检查也已加入 `npm run test:e2e:local`。
