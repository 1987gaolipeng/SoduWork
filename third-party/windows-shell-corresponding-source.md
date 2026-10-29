# Windows 外壳组件的对应源码获取方式与许可义务

登记日期：2026-10-20 · 对应缺口：`third-party/public-release.json` 条目 `windows-shell-corresponding-source`

本文档登记 Windows 安装器随发的三类外壳二进制（PortableGit / MSYS2 组件 / 7-Zip）的
**对应源码获取路径与分发义务**，作为公开发布前打包归档的可执行流程。
组件版本与引入方式以 `client/THIRD_PARTY_NOTICES.md` 的既有声明为准，本文不重复法律文本。

> 如实声明：本文档是获取与义务指引。下列 URL 为上游公开地址；
> 每次发布打包时必须核对实际分发二进制版本与下列来源的对应关系并记录哈希，
> 不得以"通用项目主页"充当对应源码证据。

## 1. PortableGit 2.55.0(4)

| 项 | 内容 |
|---|---|
| 分发身份 | `PortableGit-2.55.0-64-bit.7z.exe`（Git for Windows 发行资产） |
| 对应源码 | 发布标签 `v2.55.0.windows.4`：`https://github.com/git-for-windows/git/tree/v2.55.0.windows.4` |
| 版本级补丁与构建材料 | 同一 release 页附件（git-for-windows 每个 release 提供对应补丁/构建说明资产）；MSYS2 运行时组件按第 2 节逐包溯源 |
| 许可 | GPL-2.0（含随附的 MSYS2 组件各自许可） |
| 对应源码义务 | GPL-2.0 §3：随分发二进制提供完整对应源码，或附具至少 3 年有效的书面源码提供承诺 |

发布动作（打包时执行并记录到发布清单）：
1. 确认下载源 release 标签与安装器内 `git --version` 输出一致；
2. `curl -LO https://github.com/git-for-windows/git/archive/refs/tags/v2.55.0.windows.4.tar.gz` 并记录 sha256；
3. 将源码包（或书面 offer 文本）与二进制一同归档在发布物 `licenses/` 目录。

## 2. MSYS2 运行时组件（随 PortableGit 分发）

| 项 | 内容 |
|---|---|
| 分发身份 | PortableGit `usr/bin` 与 `usr/` 下随附的 MSYS2/mingw 工具链组件（bash、coreutils 等） |
| 对应源码 | 逐包溯源：二进制包仓库 `https://repo.msys2.org/`；源码包与构建脚本 `https://github.com/msys2/MSYS2-packages`（mingw 系为 `https://github.com/msys2/MINGW-packages`） |
| 核验方式 | 按 PortableGit release 页面的组件清单（git-for-windows 发布说明逐版本列出 MSYS2 组件版本）对齐对应源码包版本 |
| 许可 | 各组件以随包 license 文本为准（GPL/LGPL/BSD/公共域混布），发布物中保留各组件原许可文件 |

发布动作：按 git-for-windows release 说明中的 MSYS2 组件版本表，逐组件记录
"组件名/版本/源码包 URL/sha256" 清单，随发布物归档。

## 3. 7-Zip 24.09（经 electron-builder 工具集引入）

| 项 | 内容 |
|---|---|
| 分发身份 | electron-builder 26.15.3 的 app-builder 工具集随发 7-Zip 组件（解包/压缩功能） |
| 对应源码 | 官方源码包 `https://www.7-zip.org/download.html` 中对应版本条目（24.09 → `7z2409-src.7z`） |
| 核验方式 | 下载源码包记录 sha256，与 `client/THIRD_PARTY_NOTICES.md` 登记版本核对 |
| 许可 | 7-Zip 主体 LGPL-2.1 及其随附的 BSD/unRAR 限制条款（以随包 notices 为准）；unRAR 部分仅限解压用途 |

发布动作：发布物中随附 7-Zip 官方许可文本与对应源码包 URL（或归档源码包本体）。

## 4. 汇总义务清单（公开发布门禁）

- [ ] 三个组件的版本与本文档登记一致（不一致则先更新本文档再发布）；
- [ ] PortableGit 源码 tarball 已归档或书面 offer 文本已随附（GPL-2.0 §3）；
- [ ] MSYS2 组件版本表已逐项记录源码包 URL 与哈希；
- [ ] 7-Zip 源码包 URL（或本体）与许可文本已随附；
- [ ] 以上材料放入发布物 `licenses/` 目录，并在发布记录中登记各文件 sha256。
