# my-mcp-manager
统一管理本地 MCP 配置源
统一管理本地安装的 MCP (Model Context Protocol) 服务器配置的 Web 应用。

## 项目概述

MCP Manager 是一个基于 Web 的 MCP 服务器管理工具，用于可视化管理多个 AI 工具（Cursor、VS Code、Claude Desktop、GitHub Copilot、Claude Code、Codex 等）的 MCP 配置。

### 核心功能

- 多 AI 工具支持：自动检测并管理多种 MCP 配置源
- 配置可视化：图形化界面展示 MCP 服务器配置
- 格式兼容：支持 `mcpServers` / IntelliJ `servers` / Codex TOML / Claude Code `.claude.json`
- MCP 可用性检测：connect + ping
- 导入/导出：JSON 批量导入、导出安装命令

## 快速开始

### 前置要求

- Node.js 18+
- pnpm 10+

### 安装和运行

1) 克隆项目

```bash
git clone https://github.com/18896101294/my-mcp-manager.git
cd my-mcp-manager
```

2) 启动后端

```bash
cd backend
pnpm install
pnpm run dev
```

3) 启动前端（新终端）

```bash
cd frontend
pnpm install
pnpm run dev
```

4) 访问应用：`http://localhost:5173`
