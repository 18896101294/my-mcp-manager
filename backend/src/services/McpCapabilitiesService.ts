import { Client } from '@modelcontextprotocol/sdk/client';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import type { MCPServerConfig } from './ConfigService.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type McpCapabilities = {
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  resources: Array<unknown>;
  prompts: Array<unknown>;
};

export type McpCapabilitiesResult =
  | {
    ok: true;
    latencyMs: number;
    supported: { tools: boolean; resources: boolean; prompts: boolean };
    capabilities: McpCapabilities;
  }
  | { ok: false; latencyMs: number; error: string };

type McpCapabilitiesOptions = {
  timeoutMs: number;
};

type McpCapabilitiesContext = {
  cwd?: string;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error(timeoutMessage)), { once: true });
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
};

const toHeaders = (headers?: Record<string, string>): Record<string, string> | undefined => {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
};

const isUvCommand = (command?: string): boolean => {
  if (!command) return false;
  const base = path.basename(command).toLowerCase();
  return base === 'uv' || base === 'uvx';
};

const ensureDir = async (dir: string) => {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // ignore
  }
};

let runtimeCacheDirPromise: Promise<string> | null = null;
const getRuntimeCacheDir = async (): Promise<string> => {
  if (runtimeCacheDirPromise) return runtimeCacheDirPromise;

  runtimeCacheDirPromise = (async () => {
    const cwd = process.cwd();
    const candidates = [
      path.join(cwd, 'data'),
      path.join(cwd, '../data'),
      path.join(cwd, '../../data')
    ];

    for (const base of candidates) {
      try {
        await fs.access(base);
        return path.join(base, 'runtime-cache');
      } catch {
        // continue
      }
    }

    return path.join(cwd, 'data', 'runtime-cache');
  })();

  return runtimeCacheDirPromise;
};

const buildTransport = async (config: MCPServerConfig, context?: McpCapabilitiesContext): Promise<Transport> => {
  if (config.url) {
    const url = new URL(config.url);
    if (url.protocol === 'ws:' || url.protocol === 'wss:') {
      return new WebSocketClientTransport(url);
    }

    return new StreamableHTTPClientTransport(url, {
      requestInit: toHeaders(config.headers) ? ({ headers: toHeaders(config.headers) } as any) : undefined
    });
  }

  if (!config.command) {
    throw new Error('Missing command or url');
  }

  const env = { ...getDefaultEnvironment(), ...(config.env ?? {}) };

  if (isUvCommand(config.command)) {
    const baseCacheDir = await getRuntimeCacheDir();
    const uvCacheDir = path.join(baseCacheDir, 'uv');
    const xdgCacheHome = path.join(baseCacheDir, 'xdg-cache');
    await ensureDir(uvCacheDir);
    await ensureDir(xdgCacheHome);

    if (!env.UV_CACHE_DIR) env.UV_CACHE_DIR = uvCacheDir;
    if (!env.XDG_CACHE_HOME) env.XDG_CACHE_HOME = xdgCacheHome;
  }

  const cwd = context?.cwd ?? (config as any).cwd;
  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env,
    cwd,
    stderr: 'pipe'
  });
};

const isMethodMissingError = (message: string): boolean => {
  const m = message.toLowerCase();
  return (
    m.includes('method not found') ||
    m.includes('unknown method') ||
    m.includes('not implemented') ||
    m.includes('-32601')
  );
};

const tailText = (text: string, maxChars: number) => {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
};

const splitTimeout = (totalMs: number, parts: number): number[] => {
  const clamped = Math.max(500, Math.floor(totalMs));
  const p = Math.max(1, Math.floor(parts));
  const base = Math.max(250, Math.floor(clamped / p));
  const out = Array.from({ length: p }, () => base);
  out[0] += clamped - base * p;
  return out.map(x => Math.max(250, x));
};

export const getMcpCapabilities = async (
  config: MCPServerConfig,
  options: McpCapabilitiesOptions,
  context?: McpCapabilitiesContext
): Promise<McpCapabilitiesResult> => {
  const start = Date.now();
  let transport: Transport | null = null;
  let client: Client | null = null;
  const stderrChunks: Buffer[] = [];

  const attachStderr = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stderrStream = (transport as any)?.stderr;
    if (stderrStream && typeof stderrStream.on === 'function') {
      stderrStream.on('data', (chunk: any) => {
        try {
          stderrChunks.push(Buffer.from(chunk));
          if (stderrChunks.length > 50) stderrChunks.shift();
        } catch {
          // ignore
        }
      });
    }
  };

  const cleanup = async () => {
    try {
      await client?.close();
    } catch {
      // ignore
    }
    try {
      await transport?.close();
    } catch {
      // ignore
    }
    client = null;
    transport = null;
  };

  const discover = async (totalMs: number) => {
    const [toolsMs, resourcesMs, promptsMs] = splitTimeout(totalMs, 3);

    const capabilities: McpCapabilities = { tools: [], resources: [], prompts: [] };
    const supported = { tools: true, resources: true, prompts: true };

    // tools/list
    try {
      const toolsResp: any = await withTimeout((client as any).listTools(), toolsMs, 'ListTools timeout');
      const list = Array.isArray(toolsResp?.tools) ? toolsResp.tools : [];
      capabilities.tools = list.map((t: any) => ({
        name: String(t?.name ?? ''),
        description: typeof t?.description === 'string' ? t.description : undefined,
        inputSchema: t?.inputSchema ?? undefined
      })).filter((t: any) => t.name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isMethodMissingError(msg)) supported.tools = false;
      else throw e;
    }

    // resources/list (optional)
    try {
      const resResp: any = await withTimeout((client as any).listResources(), resourcesMs, 'ListResources timeout');
      const list = Array.isArray(resResp?.resources) ? resResp.resources : [];
      capabilities.resources = list;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isMethodMissingError(msg)) supported.resources = false;
      else throw e;
    }

    // prompts/list (optional)
    try {
      const promptResp: any = await withTimeout((client as any).listPrompts(), promptsMs, 'ListPrompts timeout');
      const list = Array.isArray(promptResp?.prompts) ? promptResp.prompts : [];
      capabilities.prompts = list;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isMethodMissingError(msg)) supported.prompts = false;
      else throw e;
    }

    return { capabilities, supported };
  };

  try {
    if (config.url) {
      const url = new URL(config.url);
      const headers = toHeaders(config.headers);
      const requestInit = headers ? ({ headers } as any) : undefined;

      const attempts: Array<{ name: string; make: () => Transport }> = [];
      if (url.protocol === 'ws:' || url.protocol === 'wss:') {
        attempts.push({ name: 'websocket', make: () => new WebSocketClientTransport(url) });
      } else {
        const cfgType = typeof (config as any)?.type === 'string' ? String((config as any).type).toLowerCase() : '';
        const pathname = url.pathname.toLowerCase();
        const preferLegacySse = cfgType === 'sse' || pathname.endsWith('/sse') || pathname.includes('sse');
        const preferStreamable = cfgType === 'streamable-http' || cfgType === 'http';

        const streamable = { name: 'streamable-http', make: () => new StreamableHTTPClientTransport(url, { requestInit }) };
        const legacy = { name: 'legacy-sse', make: () => new SSEClientTransport(url, { requestInit }) };

        if (preferLegacySse && !preferStreamable) attempts.push(legacy, streamable);
        else attempts.push(streamable, legacy);
      }

      const errors: string[] = [];
      const attemptTimeouts = attempts.length === 1
        ? [options.timeoutMs]
        : [Math.max(500, Math.floor(options.timeoutMs * 0.6)), Math.max(500, options.timeoutMs - Math.floor(options.timeoutMs * 0.6))];

      for (let i = 0; i < attempts.length; i += 1) {
        const attempt = attempts[i];
        const attemptTimeoutMs = attemptTimeouts[i] ?? Math.max(500, Math.floor(options.timeoutMs / attempts.length));
        try {
          transport = attempt.make();
          client = new Client({ name: 'mcp-manager', version: '0.1.0' });

          const [connectMs, discoverMs] = splitTimeout(attemptTimeoutMs, 2);
          await withTimeout(client.connect(transport), connectMs, `${attempt.name}: connect timeout`);
          const { capabilities, supported } = await discover(discoverMs);

          const latencyMs = Date.now() - start;
          return { ok: true, latencyMs, capabilities, supported };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`${attempt.name}: ${msg}`);
          await cleanup();
        }
      }

      const latencyMs = Date.now() - start;
      return { ok: false, latencyMs, error: errors.join(' | ') || 'Unavailable' };
    }

    transport = await buildTransport(config, context);
    attachStderr();
    client = new Client({ name: 'mcp-manager', version: '0.1.0' });

    const [connectMs, discoverMs] = splitTimeout(options.timeoutMs, 2);
    await withTimeout(client.connect(transport), connectMs, 'Connect timeout');
    const { capabilities, supported } = await discover(discoverMs);

    const latencyMs = Date.now() - start;
    return { ok: true, latencyMs, capabilities, supported };
  } catch (e) {
    const latencyMs = Date.now() - start;
    const error = e instanceof Error ? e.message : String(e);
    const stderrText = stderrChunks.length > 0 ? Buffer.concat(stderrChunks).toString('utf8').trim() : '';
    const withStderr = stderrText ? `${error} | stderr: ${tailText(stderrText, 2000)}` : error;
    return { ok: false, latencyMs, error: withStderr };
  } finally {
    await cleanup();
  }
};

export const getMcpCapabilitiesBatch = async (
  servers: Record<string, MCPServerConfig>,
  ids: string[],
  options: McpCapabilitiesOptions & { concurrency: number },
  context?: McpCapabilitiesContext
): Promise<Record<string, McpCapabilitiesResult>> => {
  const results: Record<string, McpCapabilitiesResult> = {};
  const queue = [...ids];

  const workers = Array.from({ length: Math.max(1, options.concurrency) }, async () => {
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) return;
      const config = servers[id];
      if (!config) {
        results[id] = { ok: false, latencyMs: 0, error: 'MCP not found' };
        continue;
      }
      results[id] = await getMcpCapabilities(config, { timeoutMs: options.timeoutMs }, context);
    }
  });

  await Promise.all(workers);
  return results;
};

