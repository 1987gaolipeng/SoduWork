# 将 CodeBuddy Code 接入为本机 ACP Agent

**简体中文** · [English](codebuddy-acp.en.md) · [文档导航](README.zh-CN.md)

可以通过 **Agent 管理 → 接入新底座**，自行接入腾讯 CodeBuddy Code。本说明使用已安装桌面客户端现有的自定义 ACP 能力，不新增内置底座，也不打包腾讯软件。

请使用本人的 CodeBuddy 账号和额度，不要多人共用账号或通过此配置转售服务；团队应向厂商配置各自获授权的账号。该账号产生的调用不由 SoduWork 模型额度承担。使用前请查阅厂商当前的服务条款。

## 范围与前提

- 已安装的 SoduWork 桌面客户端具有自定义 Agent 入口，能够连接 Hub，启动它的终端可使用 Node.js/npm。
- 单独安装下述 CodeBuddy Code **2.185.0**。明确版本号，便于主动评估升级。
- 本配方用于**本机对话**。自定义 Agent 未声明支持 SoduWork 统一访问策略或原生目标模式。其工具可以修改文件和执行命令；这不是只读或沙箱配置。首次对话请使用可丢弃的工作目录。
- 启动 SoduWork 前，先在厂商自己的终端界面登录。SoduWork 自定义 ACP 桥接尚未实现 ACP `authenticate` 交互，也没有 CodeBuddy 专用的登录或登录状态按钮。

厂商的 [ACP 文档](https://www.codebuddy.cn/docs/cli/acp)规定通过 `codebuddy --acp` 启动 stdio ACP。[安装指南](https://www.codebuddy.cn/docs/cli/installation)说明了 `CODEBUDDY_CONFIG_DIR` 与 `DISABLE_AUTOUPDATER`；不要将前者替换成 `CODEBUDDY_HOME`。

## 1. 安装到独立目录

请选择源码和业务工作区以外的目录。示例使用独立的 SoduWork 用户数据目录，不替换日常客户端设置；需要在这个独立客户端中重新登录 Hub。

Windows PowerShell：

```powershell
$codebuddyRoot = Join-Path $env:LOCALAPPDATA 'SoduWork-CodeBuddy'
$codebuddyInstall = Join-Path $codebuddyRoot 'cli'
$env:SODUWORK_USER_DATA = Join-Path $codebuddyRoot 'desktop'
$env:CODEBUDDY_CONFIG_DIR = Join-Path $env:SODUWORK_USER_DATA 'codebuddy'
$env:DISABLE_AUTOUPDATER = '1'
New-Item -ItemType Directory -Force -Path $env:CODEBUDDY_CONFIG_DIR | Out-Null
npm.cmd install --prefix "$codebuddyInstall" --save-exact @tencent-ai/codebuddy-code@2.185.0
if ($LASTEXITCODE -ne 0) { throw 'CodeBuddy installation failed' }
$codebuddyCommand = Join-Path $codebuddyInstall 'node_modules\.bin\codebuddy.cmd'
& $codebuddyCommand --version
```

macOS / Linux shell：

```sh
codebuddy_root="$HOME/.local/share/soduwork-codebuddy"
codebuddy_install="$codebuddy_root/cli"
export SODUWORK_USER_DATA="$codebuddy_root/desktop"
export CODEBUDDY_CONFIG_DIR="$SODUWORK_USER_DATA/codebuddy"
export DISABLE_AUTOUPDATER=1
mkdir -p "$CODEBUDDY_CONFIG_DIR"
npm install --prefix "$codebuddy_install" --save-exact @tencent-ai/codebuddy-code@2.185.0
codebuddy_command="$codebuddy_install/node_modules/.bin/codebuddy"
"$codebuddy_command" --version
```

安装失败或版本不是 `2.185.0` 时，先停止后续步骤。CLI 报告缺少依赖时，请按厂商对应平台的要求准备环境。以上命令不替换全局 CodeBuddy 安装；生成的 npm 锁文件保留在该独立安装目录，不属于 SoduWork 源码。

## 2. 登录后，在同一终端启动桌面客户端

在 PowerShell 执行 `& $codebuddyCommand`，或在 shell 执行 `"$codebuddy_command"`。按厂商的[交互登录说明](https://www.codebuddy.cn/docs/cli/quickstart)使用本人账号登录，再退出 CLI。登录与后续 ACP 执行必须使用同一个 `CODEBUDDY_CONFIG_DIR`。请在此环境确认账号，不要仅凭其他地方已经登录就认为可用。凭据存储仍由厂商管理，设置配置目录并不保证操作系统凭据存储也独立。不要把凭据文件复制到目录配置、启动参数、业务项目或 issue 中。

继续前，先完全退出使用该用户数据目录的 SoduWork 进程。只关闭窗口可能仍在后台运行；再次启动只会唤醒旧进程，不会更新它的环境变量。

在**同一个终端**直接运行已安装的可执行文件。将示例路径替换为实际安装路径。Windows 使用安装根目录稳定的 `SoduWork.exe`，不要使用 `.soduwork-versions` 下某个版本的可执行文件：

```powershell
& 'C:\path\to\SoduWork.exe'
```

```sh
# macOS: use the executable inside the installed application bundle.
"/Applications/SoduWork.app/Contents/MacOS/SoduWork"
# Linux: instead run your installed executable or AppImage by its absolute path.
```

以后每次启动都要设置相同的三个环境变量，再直接启动可执行文件；无需每次安装，厂商登录状态未过期时也无需重复登录。普通桌面快捷方式不会继承当前终端的环境变量。

**源码启动器限制：**`start.cmd --desktop` / `sh start.sh --desktop` 当前会过滤子进程中的 CodeBuddy 环境变量，因此不能用于本配方，`--data-dir` 也不会保留这两个变量。

安装版桌面会把环境传给自己的私有 Runner。自定义条目没有 home 覆盖，因此 CodeBuddy 使用明确指定的配置目录。这将配置与其他桌面用户数据目录分开，但同一目录中的并发对话并不独立；每个目录使用一个本人账号，在验证当前版本的并发行为前避免同时运行多个 CodeBuddy 轮次。

## 3. 注册本机 Agent

打开 **设置 → Agent 管理 → 接入新底座**，填写：

| 字段 | 内容 |
| --- | --- |
| 底座名称 | `CodeBuddy Code` |
| 启动程序 | `$codebuddyCommand` 或 `$codebuddy_command` 的完整路径，不含两端引号 |
| 启动参数 | 单独一行 `--acp` |
| 模型来源 | 使用底座自己的账号与模型 |

点击**保存并接入**。此账号模式不要选择“使用 SoduWork 中的模型”，也不要填写模型环境变量映射。注册使用现有的自定义 Agent 目录机制，无需手改 JSON 文件，也不能手工添加 `install.warn` 或 `runner.home` 字段。

点击**检测程序**可以确认可执行文件是否找到，但不能验证厂商登录、额度、ACP 认证或模型输出。新建本机对话并选择 CodeBuddy Code，再分别检查这些能力；发送提示词会使用厂商账号，可能消耗额度。正式使用前，在可丢弃的工作目录中验证简短回答、续聊、取消和文件操作。如果在终端登录后，CLI 仍要求 ACP 认证交互，请停止使用：当前桥接不支持该流程。

## 排查与停用

- **找不到程序：**使用第 1 步的准确路径。Windows 填写 `codebuddy.cmd`，不要选择 PowerShell shim，也不要在程序栏输入 `cmd /c ...` 等 shell 命令。
- **终端已登录，ACP 仍要求登录：**确认桌面已完全退出并从相同环境重新启动，两个进程使用相同配置目录，然后在该目录重新执行厂商终端登录。不要将目录内容上传到问题报告。
- **版本不对：**对界面实际登记的程序运行 `--version`。登录和桌面启动环境都保留 `DISABLE_AUTOUPDATER=1`，评估并验证新的固定版本后再重新安装。
- **停用本配方：**退出这个独立桌面，从新的终端或日常快捷方式启动原来的 SoduWork，不携带以上临时环境变量。独立目录中的会话会保留；不要通过删除用户数据目录来常规移除 Agent，自定义登记目前采用追加方式。

找到可执行文件或完成未登录的 ACP 握手，不等于已登录对话验收通过。在工作中使用这项可选接入前，还需要在自己的环境验证厂商认证、付费调用和原生桌面行为。
