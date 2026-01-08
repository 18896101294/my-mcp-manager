import { Router, Request, Response } from 'express';
import { configService } from '../services/ConfigService.js';
import { checkMcpServers } from '../services/McpCheckService.js';
import { getMcpCapabilitiesBatch } from '../services/McpCapabilitiesService.js';
import { generateAiSummary } from '../services/AiSummaryService.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const router = Router();

/**
 * GET /api/mcp
 * 获取所有 MCP 服务器列表
 * 支持 ?hostId 查询参数来指定查看哪个 host 的配置
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { hostId } = req.query;
    const hosts = await configService.getHosts();

    // 确定目标 host
    let targetHost;
    if (hostId) {
      targetHost = hosts.find(h => h.id === hostId);
      if (!targetHost) {
        return res.status(404).json({
          success: false,
          error: `Host not found: ${hostId}`
        });
      }
    } else {
      // 如果没有指定 hostId，使用活跃的 host
      targetHost = hosts.find(h => h.active);
      if (!targetHost) {
        return res.status(500).json({
          success: false,
          error: 'No active host configured'
        });
      }
    }

    // 读取配置
    const config = await configService.readConfig(targetHost.id);

    res.json({
      success: true,
      data: {
        servers: config.mcpServers,
        serverMeta: config.meta?.serverMeta ?? null,
        currentHost: targetHost.id,
        hosts: hosts
      }
    });
  } catch (error) {
    console.error('Failed to get MCP list:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/mcp/check
 * 检测 MCP Server 可用性（connect + ping）
 * body: { hostId?: string, ids?: string[], timeoutMs?: number }
 */
router.post('/check', async (req: Request, res: Response) => {
  try {
    const { hostId, ids, timeoutMs } = req.body ?? {};
    const hosts = await configService.getHosts();
    const targetHostId = hostId || hosts.find(h => h.active)?.id;

    if (!targetHostId) {
      return res.status(400).json({ success: false, error: 'No target host specified' });
    }

    const host = hosts.find(h => h.id === targetHostId);
    const config = await configService.readConfig(targetHostId);
    const allIds = Object.keys(config.mcpServers);
    const selectedIds = Array.isArray(ids) && ids.length > 0
      ? ids.filter((x: any) => typeof x === 'string')
      : allIds;

    const effectiveTimeoutMs = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
      ? Math.max(500, Math.min(30_000, Math.floor(timeoutMs)))
      : 6_000;

    const results = await checkMcpServers(config.mcpServers, selectedIds, {
      timeoutMs: effectiveTimeoutMs,
      concurrency: 2
    }, host?.scope === 'project' && host.projectPath ? { cwd: host.projectPath } : undefined);

    res.json({
      success: true,
      data: {
        hostId: targetHostId,
        timeoutMs: effectiveTimeoutMs,
        results
      }
    });
  } catch (error) {
    console.error('Failed to check MCP servers:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/mcp/capabilities
 * 获取 MCP Server 的能力（tools/resources/prompts）
 * body: { hostId?: string, ids?: string[], timeoutMs?: number }
 */
router.post('/capabilities', async (req: Request, res: Response) => {
  try {
    const { hostId, ids, timeoutMs } = req.body ?? {};
    const hosts = await configService.getHosts();
    const targetHostId = hostId || hosts.find(h => h.active)?.id;

    if (!targetHostId) {
      return res.status(400).json({ success: false, error: 'No target host specified' });
    }

    const host = hosts.find(h => h.id === targetHostId);
    const config = await configService.readConfig(targetHostId);
    const allIds = Object.keys(config.mcpServers);
    const selectedIds = Array.isArray(ids) && ids.length > 0
      ? ids.filter((x: any) => typeof x === 'string')
      : allIds;

    const effectiveTimeoutMs = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
      ? Math.max(500, Math.min(60_000, Math.floor(timeoutMs)))
      : 10_000;

    const results = await getMcpCapabilitiesBatch(config.mcpServers, selectedIds, {
      timeoutMs: effectiveTimeoutMs,
      concurrency: 2
    }, host?.scope === 'project' && host.projectPath ? { cwd: host.projectPath } : undefined);

    res.json({
      success: true,
      data: {
        hostId: targetHostId,
        timeoutMs: effectiveTimeoutMs,
        results
      }
    });
  } catch (error) {
    console.error('Failed to get MCP capabilities:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/mcp/ai-summary
 * 使用本地 codex CLI 生成 MCP 的“一句话简介”
 * body: { hostId?: string, id: string, timeoutMs?: number, model?: string }
 */
router.post('/ai-summary', async (req: Request, res: Response) => {
  try {
    const { hostId, id, timeoutMs, model } = req.body ?? {};
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing required field: id' });
    }

    const hosts = await configService.getHosts();
    const targetHostId = hostId || hosts.find(h => h.active)?.id;
    if (!targetHostId) {
      return res.status(400).json({ success: false, error: 'No target host specified' });
    }

    const host = hosts.find(h => h.id === targetHostId);
    const config = await configService.readConfig(targetHostId);
    const server = config.mcpServers[id];
    if (!server) {
      return res.status(404).json({ success: false, error: `MCP server not found: ${id}` });
    }

    const effectiveTimeoutMs = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
      ? Math.max(5_000, Math.min(180_000, Math.floor(timeoutMs)))
      : 60_000;

    // Fetch tools first (best signal) — fall back to empty on failure.
    const capResp = await getMcpCapabilitiesBatch(
      { [id]: server },
      [id],
      { timeoutMs: Math.min(15_000, effectiveTimeoutMs), concurrency: 1 },
      host?.scope === 'project' && host.projectPath ? { cwd: host.projectPath } : undefined
    );
    const cap = capResp[id];
    const tools = cap && cap.ok ? cap.capabilities.tools.map(t => ({ name: t.name, description: t.description })) : [];

    const isClaudeHost = targetHostId === 'claude-code' || targetHostId.startsWith('claude-code');
    const isCodexHost = targetHostId === 'codex' || targetHostId.startsWith('codex');
    const preferredProvider = isClaudeHost ? 'claude' : isCodexHost ? 'codex' : 'auto';

    const result = await generateAiSummary(
      { id, config: server, tools },
      {
        timeoutMs: effectiveTimeoutMs,
        model: (typeof model === 'string' && model.trim()) ? model.trim() : undefined,
        preferredProvider: preferredProvider as any
      }
    );

    if (!result.ok) {
      return res.status(500).json({ success: false, error: result.error });
    }

    res.json({
      success: true,
      data: {
        hostId: targetHostId,
        id,
        summary: result.summary,
        latencyMs: result.latencyMs,
        provider: result.provider
      }
    });
  } catch (error) {
    console.error('Failed to generate AI summary:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/mcp
 * 添加新的 MCP 服务器
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { id, config, hostId } = req.body;

    if (!id || !config) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: id, config'
      });
    }

    // 获取目标宿主
    const hosts = await configService.getHosts();
    const targetHost = hostId || hosts.find(h => h.active)?.id;

    if (!targetHost) {
      return res.status(400).json({
        success: false,
        error: 'No target host specified'
      });
    }

    await configService.addMCP(targetHost, id, config);

    res.json({
      success: true,
      message: `MCP server "${id}" added successfully`
    });
  } catch (error) {
    console.error('Failed to add MCP:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * PUT /api/mcp/:id
 * 更新 MCP 服务器配置
 */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { config, hostId } = req.body;

    if (!config) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: config'
      });
    }

    // 获取目标宿主
    const hosts = await configService.getHosts();
    const targetHost = hostId || hosts.find(h => h.active)?.id;

    if (!targetHost) {
      return res.status(400).json({
        success: false,
        error: 'No target host specified'
      });
    }

    await configService.updateMCP(targetHost, id, config);

    res.json({
      success: true,
      message: `MCP server "${id}" updated successfully`
    });
  } catch (error) {
    console.error('Failed to update MCP:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * DELETE /api/mcp/:id
 * 删除 MCP 服务器
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { hostId } = req.query;

    // 获取目标宿主
    const hosts = await configService.getHosts();
    const targetHost = (hostId as string) || hosts.find(h => h.active)?.id;

    if (!targetHost) {
      return res.status(400).json({
        success: false,
        error: 'No target host specified'
      });
    }

    await configService.deleteMCP(targetHost, id);

    res.json({
      success: true,
      message: `MCP server "${id}" deleted successfully`
    });
  } catch (error) {
    console.error('Failed to delete MCP:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * PATCH /api/mcp/:id/toggle
 * 切换 MCP 服务器启用/禁用状态
 */
router.patch('/:id/toggle', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { hostId } = req.query;

    // 获取目标宿主
    const hosts = await configService.getHosts();
    const targetHost = (hostId as string) || hosts.find(h => h.active)?.id;

    if (!targetHost) {
      return res.status(400).json({
        success: false,
        error: 'No target host specified'
      });
    }

    const enabled = await configService.toggleMCP(targetHost, id);

    res.json({
      success: true,
      enabled,
      message: `MCP server "${id}" ${enabled ? 'enabled' : 'disabled'} successfully`
    });
  } catch (error) {
    console.error('Failed to toggle MCP:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/mcp/script
 * 查看本地脚本内容（主要用于 stdio 里运行的 .py/.js/.ts 等）
 * query: { hostId?: string, id: string }
 */
router.get('/script', async (req: Request, res: Response) => {
  try {
    const { hostId, id } = req.query as any;
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing required query: id' });
    }

    const hosts = await configService.getHosts();
    const targetHostId = (typeof hostId === 'string' && hostId) ? hostId : (hosts.find(h => h.active)?.id);
    if (!targetHostId) {
      return res.status(400).json({ success: false, error: 'No target host specified' });
    }

    const host = hosts.find(h => h.id === targetHostId);
    if (!host) {
      return res.status(404).json({ success: false, error: `Host not found: ${targetHostId}` });
    }

    const config = await configService.readConfig(targetHostId);
    const server = (config.mcpServers as any)?.[id];
    if (!server) {
      return res.status(404).json({ success: false, error: `MCP server not found: ${id}` });
    }

    const command = typeof server.command === 'string' ? server.command : '';
    const args = Array.isArray(server.args) ? server.args.map((x: any) => String(x)) : [];
    const base = command.split('/').pop()?.toLowerCase() ?? command.toLowerCase();

    const looksLikeScript = (p: string) => /\.(py|js|ts|mjs|cjs|tsx|jsx)$/i.test(p);

    const pickScriptFromArgs = (): string | null => {
      if (args.length === 0) return null;

      // uv run xxx.py
      const runIdx = args.findIndex((a: string) => a === 'run');
      if (runIdx !== -1 && typeof args[runIdx + 1] === 'string' && looksLikeScript(args[runIdx + 1])) {
        return args[runIdx + 1];
      }

      // python xxx.py / python -m ... (ignore)
      const direct = args.find((a: string) => looksLikeScript(a));
      if (direct) return direct;

      return null;
    };

    if (!command || !['uv', 'uvx', 'python', 'python3', 'py', 'node', 'bun'].includes(base)) {
      return res.status(400).json({ success: false, error: 'This MCP server does not look like a local script runner' });
    }

    const scriptArg = pickScriptFromArgs();
    if (!scriptArg) {
      return res.status(404).json({ success: false, error: 'No script file detected in args' });
    }

    const baseDir = (host.scope === 'project' && host.projectPath)
      ? host.projectPath
      : path.dirname(host.configPath);

    const scriptPath = path.isAbsolute(scriptArg) ? scriptArg : path.resolve(baseDir, scriptArg);
    const stat = await fs.stat(scriptPath);
    if (!stat.isFile()) {
      return res.status(400).json({ success: false, error: `Not a file: ${scriptPath}` });
    }
    if (stat.size > 1024 * 1024) {
      return res.status(413).json({ success: false, error: `Script too large (>1MB): ${scriptPath}` });
    }

    const content = await fs.readFile(scriptPath, 'utf-8');
    const ext = path.extname(scriptPath).toLowerCase();
    const language =
      ext === '.py' ? 'python'
        : (ext === '.ts' || ext === '.tsx') ? 'typescript'
          : (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') ? 'javascript'
            : 'text';

    res.json({
      success: true,
      data: {
        hostId: targetHostId,
        id,
        scriptPath,
        language,
        content
      }
    });
  } catch (error) {
    console.error('Failed to read MCP script:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/mcp/hosts
 * 获取所有宿主配置
 */
router.get('/hosts', async (req: Request, res: Response) => {
  try {
    const hosts = await configService.getHosts();

    res.json({
      success: true,
      data: {
        hosts
      }
    });
  } catch (error) {
    console.error('Failed to get hosts:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
