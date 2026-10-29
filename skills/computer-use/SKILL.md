---
name: computer-use
description: Use when a Windows desktop application has no reliable CLI or web entry point, or when a real mouse, keyboard, window, or screen must be verified end to end.
---

# Computer Use

通过 PowerShell + .NET 操作**本机 Windows 桌面**。脚本使用真实鼠标消息、高分屏坐标和可取消的桌面控制租约；输入失败会返回非零退出码，不能把失败当成成功。

## 安全护栏

1. **先看再动**：点击、输入或快捷键前先 `shot`，确认前台窗口、目标和物理坐标；动作后再截图留证。
2. 只在当前请求明确授权时填写凭据；不把凭据写入文件、日志或截图。不要操作系统设置、安全软件、防火墙、注册表、管理员弹窗、支付、删除、卸载或不可逆确认框。
3. 先 `windows` 检查前台窗口；无关窗口先 `focus`。用户按 Esc 或提示层取消后立即停止，不绕过租约、不自动重试这一轮。
4. 坐标必须来自最新截图；脚本拒绝桌面范围外的鼠标坐标、越界截图、超过 64 MP 的截图、过长文本和未声明的批量动作。

## 快速参考

```powershell
$s = '<技能目录>/scripts/screen.ps1'
powershell -File $s shot before.png
powershell -File $s windows
powershell -File $s focus '窗口标题片段'
powershell -File $s click 640 480
powershell -File $s type '要输入的文字'
powershell -File $s key '^s'
'[{"cmd":"click","x":640,"y":480},{"cmd":"wait","ms":300},{"cmd":"key","keys":"^s"}]' |
  powershell -File $s batch stdin
```

批量动作最多 50 步，仅允许 `wait`（0–5000 ms）、`move`、`click`、`dblclick`、`rclick`、`type`（最多 4000 字符）和 `key`（最多 64 字符）。批量执行只初始化一次桌面租约，适合连续操作，仍会在每步前检查取消状态。

## SoduWork 控制层

保留运行时注入的 `SODUWORK_DESKTOP_CONTROL_ENDPOINT` 和轮次标识。首次输入会等待真实的提示层就绪；截图和窗口查询不启动提示层。独立 Runner 没有本机提示层，不能假设存在彩虹边框或鼠标光环。

## 交付与验证

关键操作要保留操作前后截图，并说明观察到的窗口、坐标和结果。发生超时、取消、前台窗口变化或脚本非零退出时，停止并报告原因；不要用另一套输入工具绕过本技能。
