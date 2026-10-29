---
name: mcp-tools
description: 调用管理员接进来的 MCP 工具（Model Context Protocol）——比如查内网知识库、读数据库、访问公司自建的服务。当任务需要"去某个系统里查/取/写点什么"、而这件事本机命令行做不到时使用。先 list 看有哪些工具，再 call。
---

# MCP 工具（mcp-tools）

MCP 是"给模型接外部系统"的通用协议。管理员把公司的 MCP server 配进来之后，
你就能用**一条命令行**调它们的工具——不用管它是 Node 写的还是 Python 写的。

## 三步

```bash
# 1. 有哪些 server
node <技能目录>/scripts/mcp.mjs servers

# 2. 这个 server 有哪些工具（会打出名字、说明、入参）
node <技能目录>/scripts/mcp.mjs list <server名>

# 3. 调一个工具（参数是 JSON）
node <技能目录>/scripts/mcp.mjs call <server名> <工具名> '{"参数":"值"}'
```

**先 `list` 再 `call`**。入参是什么、必填哪几个，`list` 都会打出来，别自己猜字段名。

应用或插件已提供本轮 MCP 指引时，使用其中的桥接脚本绝对路径和同一个 `--config`，优先于上面的默认配置示例。带空格的路径保留引号；JSON 参数使用 `shell=false` 的子进程参数数组或 `SODUWORK_MCP_ARGS_STDIN=1` 从标准输入传入。授权文件由壳管理，不能读取、展示或复制其中内容。不要改用缓存中的旧桥或自写 HTTP 脚本绕过连接错误；报告错误，由宿主修复连接。

较长正文直接从标准输入传入，不经临时文件或 `$(cat ...)`。Bash 示例（替换为本轮路径和实际业务参数）：

```bash
SODUWORK_MCP_ARGS_STDIN=1 node "<本轮桥路径>" --config "<本轮授权路径>" call media-ops-cloud put_settings <<'MCP_ARGS'
{"space_id":"<空间>","series_id":"<系列>","settings":{"doc":"设定正文，换行用\\n"}}
MCP_ARGS
```

单引号结束标记使正文中的 `$`、反引号和引号不被 shell 展开。如果文件读成非明文或含空字节，先确认文件保护；不要猜编码或转换受保护内容。

## 规矩

1. **调之前先说清你要干什么**：哪个 server、哪个工具、传什么参数。调完说明实际结果和证据，敏感字段不输出。
2. **写类工具要格外小心**：名字里带 create/update/delete/write/send 的，
   调之前先确认任务正文真的要求这么做；不确定就停下来问，别"顺手试一下"。
3. **不要把密钥、密码、个人信息当参数传进去**，也不要把工具返回里的敏感内容原样贴进产出文件。
4. 一次只调一个工具，看清结果再决定下一步——MCP 工具背后往往是真实系统。
5. 调不通时先看错误原文（server 起没起来、参数缺没缺），把原文贴出来；
   加 `SODUWORK_MCP_DEBUG=1` 能看到 server 自己打的 stderr。

## 配置在哪儿（给管理员看）

同目录的 `servers.json`（或环境变量 `SODUWORK_MCP_SERVERS` 指向别处）：

```json
{
  "servers": {
    "文件": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/公共资料"],
      "description": "只读公司公共资料目录"
    }
  }
}
```

- `command` / `args` 就是启动这个 server 的命令行；`env` 可选（放它需要的环境变量）。
- ⚠️ **凭据别写死在这个文件里**——用 `env` 引环境变量，别把明文密钥提交进仓库。
- Windows 上 `npx`/`uvx` 这类垫片脚本能直接写，桥接会自己处理。
