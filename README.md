# my-mcp-manager

统一管理本地 MCP 配置源：用一个 Web 界面管理多个 AI 工具的 MCP（Model Context Protocol）服务器配置。

## 功能概览

- 多配置源：自动检测并管理 Cursor / VS Code / Claude Desktop / Claude Code / GitHub Copilot（IntelliJ）/ Codex
- 配置编辑：新增、编辑、删除 MCP server；支持 stdio（command/args/env）和 URL（http/sse/websocket）
- 启用/禁用：支持多数配置源；Claude Code 用户级不支持（Claude 的启用/禁用仅对“项目级”生效）
- 批量导入/导出：JSON 批量导入；导出 JSON；导出安装命令（`claude mcp add` / `codex mcp add`）
- 可用性检测：connect + ping
- 能力发现：读取 tools/resources/prompts（并做本地缓存）
- 一键查看：展示本地脚本源码（stdio 模式常见的 `.py/.js/.ts`）与当前配置源的配置文件原文（只读）
- AI 一句话简介：调用本地 `codex` 或 `claude` CLI，基于 tools 列表生成中文简介（不会上传配置文件原文）

## 支持的配置源（Host）

> 默认路径以 macOS 为主；Cursor/Codex/Claude Code 也可在其它平台使用（但 VS Code/Claude Desktop 的默认路径可能需要你按系统调整代码）。

| 工具 | Host ID | 默认配置路径 | 格式/来源 |
| --- | --- | --- | --- |
| Cursor | `cursor` | `~/.cursor/mcp.json` | `mcpServers` JSON |
| VS Code | `vscode` | `~/Library/Application Support/Code/User/mcp.json` | `mcpServers` JSON |
| Claude Desktop | `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers` JSON |
| Claude Code（用户级） | `claude-code` | `~/.claude.json` | `.claude.json`（兼容 `mcpServers`/`mcp.mcpServers`） |
| GitHub Copilot（IntelliJ） | `copilot` | `~/.config/github-copilot/intellij/mcp.json` | `servers` JSON |
| Codex | `codex` | `~/.codex/config.toml` | 通过 `codex mcp *` 读写（并在 TOML 中切换 enabled） |

另外还会尝试自动检测：

- Cursor 项目级：扫描目录下的 `<project>/.cursor/mcp.json`
- Claude Code 项目级：从 `~/.claude.json` 的 `projects`（或以绝对路径为 key 的 section）中识别项目配置源

项目扫描可通过环境变量控制（见下文）。

## 快速开始（开发）

### 前置要求

- Node.js 18+
- pnpm 10+

可选（启用部分功能）：

- `codex` CLI：用于 “Codex 配置源” 的读写；也用于 AI 简介（若同时安装了 `claude`，仍优先用 `codex`）
- `claude` CLI：当未安装 `codex` 时，用于 AI 简介

### 安装与运行

1) 启动后端（默认 `http://localhost:3000`）

```bash
cd backend
pnpm install
pnpm dev
```

2) 启动前端（默认 `http://localhost:5173`）

```bash
cd frontend
pnpm install
pnpm dev
```

3) 打开：`http://localhost:5173`

> 注意：本项目会直接读写你本机的 MCP 配置文件（并在 `data/backups/` 生成备份）。建议先用不重要的配置源验证流程。

## 配置与环境变量

### 后端端口

- `PORT`：后端端口（默认 `3000`）

注意：后端 CORS 目前固定允许 `http://localhost:5173`（开发环境）。如需改端口或改域名，需要同步修改后端 `backend/src/app.ts` 与前端 `frontend/src/services/api.ts`。

### 项目扫描（自动发现项目级配置源）

> 扫描用于自动发现 `<project>/.cursor/mcp.json` 以及 Claude Code 的项目 section；你可以通过这些环境变量限制扫描范围以提升性能。

- `MCP_PROJECT_SCAN_PATHS`：扫描根目录列表，支持用 `, : ; \n` 分隔（会自动 `~` 展开并 `resolve`）
- `MCP_PROJECT_SCAN_MAX_DEPTH`：最大扫描深度（默认 `4`，范围 `0..12`）
- `MCP_PROJECT_SCAN_MAX_RESULTS`：最多发现多少个项目配置源（默认 `300`，范围 `1..5000`）

示例：

```bash
export MCP_PROJECT_SCAN_PATHS="~/Projects,~/Work"
export MCP_PROJECT_SCAN_MAX_DEPTH=3
export MCP_PROJECT_SCAN_MAX_RESULTS=200
```

## 数据、缓存与备份

> 这里可能包含敏感信息（token/env/headers），不要提交到 Git。

- `data/backups/`：每次 add/update/delete/toggle 前会备份目标配置源的原文件（便于回滚）
- `data/runtime-cache/`：运行时缓存（例如 uv/uvx 的缓存目录、capabilities 缓存文件）
- 浏览器本地：会缓存 capabilities/简介等信息（localStorage），用于加速界面显示与减少重复探测

## API（后端）

后端默认监听 `http://localhost:3000`，API base 为 `/api/mcp`：

- `GET /api/mcp?hostId=...`：读取指定 host 的 MCP 列表（不传则读取当前 active host）
- `GET /api/mcp/hosts`：列出可用配置源（含自动检测的项目级 host）
- `POST /api/mcp`：新增 MCP（body: `{ id, config, hostId? }`）
- `PUT /api/mcp/:id`：更新 MCP（body: `{ config, hostId? }`）
- `DELETE /api/mcp/:id?hostId=...`：删除 MCP
- `PATCH /api/mcp/:id/toggle?hostId=...`：切换启用/禁用（Claude Code 仅项目级支持）
- `POST /api/mcp/check`：可用性检测（body: `{ ids?, hostId?, timeoutMs? }`）
- `POST /api/mcp/capabilities`：读取 tools/resources/prompts（body: `{ ids?, hostId?, timeoutMs?, force?, noCache? }`）
- `POST /api/mcp/ai-summary`：生成一句话简介（body: `{ id, hostId?, timeoutMs?, model? }`）
- `GET /api/mcp/script?id=...&hostId=...`：读取 stdio 启动脚本内容（仅支持常见 runner，且文件大小限制 1MB）
- `GET /api/mcp/host-config-file?hostId=...`：读取当前 host 的配置文件原文（只读，文件大小限制 2MB）

## 常见问题

### Codex 配置源用不了 / AI 简介失败

- 确认本机已安装并可执行：`codex`（或 `claude`）
- 需要已登录（CLI 能正常非交互运行），否则后端会返回错误信息

### 扫描项目很慢

- 用 `MCP_PROJECT_SCAN_PATHS` 限制扫描目录
- 调小 `MCP_PROJECT_SCAN_MAX_DEPTH` 或 `MCP_PROJECT_SCAN_MAX_RESULTS`

### 启动后前端请求报跨域/连不上后端

- 前端默认请求 `http://localhost:3000/api`（见 `frontend/src/services/api.ts`）
- 后端 CORS 默认只允许 `http://localhost:5173`（见 `backend/src/app.ts`）

## 构建（可选）

后端：

```bash
cd backend
pnpm build
pnpm start
```

前端：

```bash
cd frontend
pnpm build
pnpm preview
```

## 开发命令（可选）

- 前端 lint：`cd frontend && pnpm lint`
