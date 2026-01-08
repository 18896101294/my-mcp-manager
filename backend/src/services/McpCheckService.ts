import { Client } from '@modelcontextprotocol/sdk/client';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { MCPServerConfig } from './ConfigService.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type McpCheckResult =
  | { ok: true; latencyMs: number }
  | { ok: false; latencyMs: number; error: string };

type McpCheckOptions = {
  timeoutMs: number;
};

type McpCheckContext = {
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

const buildTransport = async (config: MCPServerConfig, context?: McpCheckContext): Promise<Transport> => {
  if (config.url) {
    const url = new URL(config.url);
    if (url.protocol === 'ws:' || url.protocol === 'wss:') {
      return new WebSocketClientTransport(url);
    }

    // Default to streamable HTTP for HTTP(S) URLs; legacy SSE is handled in the url-check fallback.
    return new StreamableHTTPClientTransport(url, {
      requestInit: toHeaders(config.headers) ? ({ headers: toHeaders(config.headers) } as any) : undefined
    });
  }

  if (!config.command) {
    throw new Error('Missing command or url');
  }

  const env = { ...getDefaultEnvironment(), ...(config.env ?? {}) };

  // Some stdio MCP servers are launched via `uv run ...` and require cache access.
  // In restricted environments, ~/.cache may be blocked; use a workspace cache for checks.
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

export const checkMcpServer = async (
  config: MCPServerConfig,
  options: McpCheckOptions,
  context?: McpCheckContext
): Promise<McpCheckResult> => {
  const start = Date.now();
  let transport: Transport | null = null;
  let client: Client | null = null;
  const stderrChunks: Buffer[] = [];

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

      const splitTimeout = (totalMs: number, parts: number): number[] => {
        const clamped = Math.max(500, Math.floor(totalMs));
        const p = Math.max(1, Math.floor(parts));
        const base = Math.max(250, Math.floor(clamped / p));
        const out = Array.from({ length: p }, () => base);
        out[0] += clamped - base * p;
        return out.map(x => Math.max(250, x));
      };

      const tryOnce = async (attempt: { name: string; make: () => Transport }, attemptTimeoutMs: number) => {
        transport = attempt.make();
        client = new Client({ name: 'mcp-manager', version: '0.1.0' });
        const [connectTimeoutMs, pingTimeoutMs] = splitTimeout(attemptTimeoutMs, 2);
        await withTimeout(client.connect(transport), connectTimeoutMs, `${attempt.name}: connect timeout`);
        await withTimeout(client.ping(), pingTimeoutMs, `${attempt.name}: ping timeout`);
      };

      const attemptTimeouts = attempts.length === 1
        ? [options.timeoutMs]
        : [Math.max(500, Math.floor(options.timeoutMs * 0.6)), Math.max(500, options.timeoutMs - Math.floor(options.timeoutMs * 0.6))];

      for (let i = 0; i < attempts.length; i += 1) {
        const attempt = attempts[i];
        const attemptTimeoutMs = attemptTimeouts[i] ?? Math.max(500, Math.floor(options.timeoutMs / attempts.length));
        try {
          await tryOnce(attempt, attemptTimeoutMs);
          const latencyMs = Date.now() - start;
          return { ok: true, latencyMs };
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
    client = new Client({ name: 'mcp-manager', version: '0.1.0' });

    // Capture stderr for better diagnostics on local stdio servers.
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

    await withTimeout(client.connect(transport), options.timeoutMs, 'Connect timeout');
    try {
      await withTimeout(client.ping(), options.timeoutMs, 'Ping timeout');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isMethodMissingError(msg)) {
        // Older servers may not implement ping; fall back to a lightweight method.
        await withTimeout(client.listTools(), options.timeoutMs, 'ListTools timeout');
      } else {
        throw e;
      }
    }

    const latencyMs = Date.now() - start;
    return { ok: true, latencyMs };
  } catch (e) {
    const latencyMs = Date.now() - start;
    const error = e instanceof Error ? e.message : String(e);
    const stderrText = stderrChunks.length > 0 ? Buffer.concat(stderrChunks).toString('utf8').trim() : '';
    const withStderr = stderrText ? `${error} | stderr: ${tailText(stderrText, 2000)}` : error;
    return { ok: false, latencyMs, error: withStderr };
  } finally {
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
  }
};

export const checkMcpServers = async (
  servers: Record<string, MCPServerConfig>,
  ids: string[],
  options: McpCheckOptions & { concurrency: number },
  context?: McpCheckContext
): Promise<Record<string, McpCheckResult>> => {
  const results: Record<string, McpCheckResult> = {};
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
      results[id] = await checkMcpServer(config, { timeoutMs: options.timeoutMs }, context);
    }
  });

  await Promise.all(workers);
  return results;
};
