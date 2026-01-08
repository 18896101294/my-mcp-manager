import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MCPServerConfig } from './ConfigService.js';

const execFileAsync = promisify(execFile);

const runCodex = async (args: string[], timeoutMs = 10_000): Promise<{ stdout: string; stderr: string }> => {
  const { stdout, stderr } = await execFileAsync('codex', args, {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024
  });
  return { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
};

export const listCodexMcpServers = async (): Promise<string[]> => {
  // Prefer JSON output to avoid parsing the table format.
  try {
    const { stdout, stderr } = await runCodex(['mcp', 'list', '--json'], 10_000);
    const text = (stdout.trim() || stderr.trim()).trim();
    if (!text) return [];
    const parsed = JSON.parse(text) as Array<{ name?: string }>;
    const names = parsed
      .map(x => (typeof x?.name === 'string' ? x.name.trim() : ''))
      .filter(Boolean);
    return Array.from(new Set(names));
  } catch {
    // Fallback for older Codex builds: parse text output.
    const { stdout, stderr } = await runCodex(['mcp', 'list'], 10_000);
    const text = (stdout.trim() || stderr.trim()).trim();
    if (!text) return [];
    if (/^No MCP servers configured yet\./i.test(text)) return [];

    const names: string[] = [];
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^No MCP servers configured yet\./i.test(line)) continue;
      if (/^Try `codex mcp add/i.test(line)) continue;
      if (/^Name\s+Command\b/i.test(line)) continue; // table header

      const token = line.replace(/^[-*]\s*/, '').split(/\s+/)[0];
      if (token && token.toLowerCase() !== 'name') names.push(token);
    }

    return Array.from(new Set(names));
  }
};

type CodexMcpGetJson = {
  // Newer Codex schema
  name?: string;
  enabled?: boolean;
  transport?: {
    type?: string;
    // stdio
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string | null;
    // streamable http
    url?: string;
    headers?: Record<string, string>;
    bearer_token_env_var?: string;
    bearerTokenEnvVar?: string;
  };

  // Legacy/flat schema (best-effort compatibility)
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  disabled?: boolean;
  bearer_token_env_var?: string;
  bearerTokenEnvVar?: string;
};

export const getCodexMcpServer = async (name: string): Promise<MCPServerConfig> => {
  const { stdout, stderr } = await runCodex(['mcp', 'get', name, '--json'], 10_000);
  const text = (stdout.trim() || stderr.trim()).trim();
  const json = JSON.parse(text) as CodexMcpGetJson;

  const config: MCPServerConfig = {};

  const enabled = typeof json.enabled === 'boolean' ? json.enabled : undefined;
  if (typeof enabled === 'boolean') config.disabled = !enabled;

  const transport = json.transport;
  if (transport && typeof transport === 'object') {
    if (typeof transport.type === 'string') config.type = transport.type;
    if (typeof transport.cwd === 'string') config.cwd = transport.cwd;

    if (typeof transport.url === 'string') config.url = transport.url;
    if (typeof transport.command === 'string') config.command = transport.command;
    if (Array.isArray(transport.args)) config.args = transport.args.map(String);
    if (transport.env && typeof transport.env === 'object') config.env = transport.env as Record<string, string>;
    if (transport.headers && typeof transport.headers === 'object') config.headers = transport.headers as Record<string, string>;

    const bearer =
      typeof transport.bearer_token_env_var === 'string'
        ? transport.bearer_token_env_var
        : typeof transport.bearerTokenEnvVar === 'string'
          ? transport.bearerTokenEnvVar
          : undefined;
    if (bearer) {
      config.headers = { ...(config.headers ?? {}), 'x-codex-bearer-token-env-var': bearer };
    }

    return config;
  }

  // Legacy/flat fields
  if (typeof json.url === 'string') config.url = json.url;
  if (typeof json.command === 'string') config.command = json.command;
  if (Array.isArray(json.args)) config.args = json.args.map(String);
  if (json.env && typeof json.env === 'object') config.env = json.env as Record<string, string>;
  if (json.headers && typeof json.headers === 'object') config.headers = json.headers as Record<string, string>;
  if (typeof json.disabled === 'boolean') config.disabled = json.disabled;

  const bearer =
    typeof json.bearer_token_env_var === 'string'
      ? json.bearer_token_env_var
      : typeof json.bearerTokenEnvVar === 'string'
        ? json.bearerTokenEnvVar
        : undefined;
  if (bearer) {
    config.headers = { ...(config.headers ?? {}), 'x-codex-bearer-token-env-var': bearer };
  }

  return config;
};

export const addCodexMcpServer = async (name: string, config: MCPServerConfig): Promise<void> => {
  if (config.url) {
    const args = ['mcp', 'add', name, '--url', config.url];
    const bearerTokenEnvVar = config.headers?.['x-codex-bearer-token-env-var'];
    if (bearerTokenEnvVar) {
      args.push('--bearer-token-env-var', bearerTokenEnvVar);
    }
    await runCodex(args, 15_000);
    return;
  }

  if (!config.command) {
    throw new Error('Missing command or url');
  }

  const args = ['mcp', 'add', name];
  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      args.push('--env', `${key}=${value}`);
    }
  }
  args.push('--', config.command, ...(config.args ?? []));
  await runCodex(args, 15_000);
};

export const removeCodexMcpServer = async (name: string): Promise<void> => {
  await runCodex(['mcp', 'remove', name], 10_000);
};
