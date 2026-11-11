# SoduWork 管理端

**简体中文** · [English](README.md) · [开发指南](../docs/development.md#管理页面)

命令示例中的 `sh start.sh` 适用于 macOS/Linux；Windows PowerShell 使用 `.\start.cmd`，命令提示符使用 `start.cmd`，参数相同。独立 Python 工具示例使用 `python3`；Windows 使用 `py`，已激活虚拟环境时使用 `python`。

React + Vite 应用，对接 `../hub-backend` 的管理 API。当前入口为 `src/main.jsx`，路由与页面在 `src/` 维护；设计原型不参与应用运行。

## 职责

管理组织与账号、客户端与执行网络、模型与能力、任务与审批、插件和发布配置。权限由 Hub 校验，前端隐藏按钮不能替代接口权限检查。

## 开发运行

先起后端（另一个终端）：
```bash
cd ../hub-backend
.venv/Scripts/python -m uvicorn app.main:app --port 9080
```
再起前端：
```bash
npm ci             # 按锁文件安装
npm run dev        # http://localhost:5173
```
Vite 将 `/api`、`/healthz` 和 `/readyz` 代理到 `127.0.0.1:9080`（见 `vite.config.js`）。如果配合根目录 `sh start.sh` 使用，先通过 `SODUWORK_DEV_HUB` 将代理指向 `http://127.0.0.1:18989`，具体命令见[开发指南](../docs/development.md#管理页面)。登录使用 Hub 的用户账号；首次初始化管理员由 Hub 的 `ADMIN_USER` / `ADMIN_PASS` 配置产生，后续通过用户管理维护，不是前端写死账号。

## 验证与构建
```bash
node --test tests/*.test.mjs
npm run build      # dist/ 为生成物，由 Hub 或部署环境托管
```

浏览器场景见 `tests/` 中的独立运行脚本；真实环境测试与隔离页面夹具应分别记录。`dist/`、依赖和本地配置不提交到 Git。
