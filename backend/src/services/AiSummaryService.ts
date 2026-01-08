import type { MCPServerConfig } from './ConfigService.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type AiSummaryTool = { name: string; description?: string };

export type AiSummaryInput = {
  id: string;
  config: MCPServerConfig;
  tools: AiSummaryTool[];
};

export type AiSummaryResult =
  | { ok: true; latencyMs: number; provider: 'codex' | 'claude'; summary: string }
  | { ok: false; latencyMs: number; provider: 'codex' | 'claude'; error: string };

const isCliAvailable = async (cmd: string): Promise<boolean> => {
  const tool = process.platform === 'win32' ? 'where' : 'which';
  return await new Promise<boolean>((resolve) => {
    const child = spawn(tool, [cmd], { stdio: ['ignore', 'ignore', 'ignore'] });
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve(false);
    }, 1500);
    child.once('close', (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
    child.once('error', () => {
      clearTimeout(t);
      resolve(false);
    });
  });
};

const redactConfigForAi = (cfg: MCPServerConfig): MCPServerConfig => {
  const next: MCPServerConfig = { ...(cfg as any) };

  if (next.env && typeof next.env === 'object') {
    const envKeys: Record<string, string> = {};
    for (const k of Object.keys(next.env)) envKeys[k] = '<redacted>';
    next.env = envKeys;
  }
  if (next.headers && typeof next.headers === 'object') {
    const headerKeys: Record<string, string> = {};
    for (const k of Object.keys(next.headers)) headerKeys[k] = '<redacted>';
    next.headers = headerKeys;
  }

  return next;
};

const buildPromptZh = (input: AiSummaryInput): string => {
  const cfg = redactConfigForAi(input.config);

  const looksSensitiveKey = (k: string) => /(token|api[-_]?key|secret|password|passwd|pwd|bearer)/i.test(k);
  const looksLikeSecretValue = (v: string) => /[A-Za-z0-9_\\-]{32,}/.test(v) || /[a-f0-9]{32,}/i.test(v);
  const redactArg = (arg: string) => {
    const s = String(arg ?? '');
    const m = s.match(/^--?([^=]+)=(.+)$/);
    if (m) {
      const key = m[1] ?? '';
      const value = m[2] ?? '';
      if (looksSensitiveKey(key) || looksLikeSecretValue(value)) return `${m[0].split('=')[0]}=<redacted>`;
    }
    if (looksSensitiveKey(s)) return '<redacted>';
    if (looksLikeSecretValue(s)) return '<redacted>';
    return s;
  };

  const safeUrl = (raw: string) => {
    try {
      const u = new URL(raw);
      u.username = '';
      u.password = '';
      u.search = '';
      return u.toString();
    } catch {
      return String(raw).split('?')[0];
    }
  };

  const transport =
    cfg.url
      ? { url: safeUrl(cfg.url), type: cfg.type ?? undefined }
      : {
        command: cfg.command ?? '',
        args: (cfg.args ?? []).map(redactArg),
        cwd: cfg.cwd ?? undefined
      };

  const tools = (input.tools ?? [])
    .map(t => ({
      name: String(t?.name ?? '').trim(),
      description: typeof t?.description === 'string' ? t.description.trim().replace(/\s+/g, ' ') : ''
    }))
    .filter(t => t.name)
    .slice(0, 60);

  const toolLines = tools.map(t => `- ${t.name}${t.description ? `: ${t.description}` : ''}`).join('\n');
  const toolNote = tools.length === 0 ? '(tools 为空或不可用)' : toolLines;

  return [
    '你是一个软件工程师助手。',
    '请根据下面提供的 MCP Server 信息，用一句中文概括“这个 MCP 能干什么”。',
    '要求：',
    '- 只基于提供的信息，不要臆测未提及的能力。',
    '- 如果信息不足，用“提供若干工具，主要涵盖：...”这种保守表述。',
    '- 输出仅一行中文，不要列表/不要 Markdown/不要引号。',
    '',
    `MCP id: ${input.id}`,
    `Transport: ${JSON.stringify(transport)}`,
    '',
    'Tools:',
    toolNote
  ].join('\n');
};

export const generateAiSummaryWithCodex = async (
  input: AiSummaryInput,
  options?: { model?: string; timeoutMs?: number }
): Promise<AiSummaryResult> => {
  const start = Date.now();
  const timeoutMs = typeof options?.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
    ? Math.max(5_000, Math.min(180_000, Math.floor(options.timeoutMs)))
    : 60_000;

  const prompt = buildPromptZh(input);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-manager-ai-summary-'));
  const outFile = path.join(tmpDir, 'last-message.txt');

  const args: string[] = [
    'exec',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--color',
    'never',
    '--output-last-message',
    outFile
  ];
  if (options?.model) {
    args.push('--model', options.model);
  }
  args.push('-'); // prompt from stdin

  try {
    const child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => stdoutChunks.push(Buffer.from(d)));
    child.stderr.on('data', (d: Buffer) => stderrChunks.push(Buffer.from(d)));

    const donePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, timeoutMs);

      child.once('error', (err) => {
        clearTimeout(t);
        reject(err);
      });
      child.once('close', (code, signal) => {
        clearTimeout(t);
        resolve({ code, signal });
      });
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch {
      // ignore
    }

    const done = await donePromise;

    if (done.code !== 0) {
      const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim();
      const msg = (stderr || stdout || `codex exited with code ${done.code ?? 'null'}`).slice(0, 3000);
      return { ok: false, provider: 'codex', latencyMs: Date.now() - start, error: msg };
    }

    let summary = '';
    try {
      summary = (await fs.readFile(outFile, 'utf-8')).trim();
    } catch {
      summary = '';
    }

    // Normalize to 1 line.
    summary = summary.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!summary) {
      return { ok: false, provider: 'codex', latencyMs: Date.now() - start, error: 'Empty summary from codex' };
    }
    return { ok: true, provider: 'codex', latencyMs: Date.now() - start, summary };
  } catch (e: any) {
    const msg = e?.stderr ? String(e.stderr) : (e instanceof Error ? e.message : String(e));
    const error = String(msg || 'Failed to run codex').trim().slice(0, 3000);
    return { ok: false, provider: 'codex', latencyMs: Date.now() - start, error };
  } finally {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
};

export const generateAiSummaryWithClaude = async (
  input: AiSummaryInput,
  options?: { model?: string; timeoutMs?: number }
): Promise<AiSummaryResult> => {
  const start = Date.now();
  const timeoutMs = typeof options?.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
    ? Math.max(5_000, Math.min(180_000, Math.floor(options.timeoutMs)))
    : 60_000;

  const prompt = buildPromptZh(input);

  const candidates: Array<string[]> = [];
  if (options?.model) {
    candidates.push(['-p', prompt, '--model', options.model]);
    candidates.push(['--print', prompt, '--model', options.model]);
  }
  candidates.push(['-p', prompt]);
  candidates.push(['--print', prompt]);

  for (const args of candidates) {
    try {
      const child = spawn('claude', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' }
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => stdoutChunks.push(Buffer.from(d)));
      child.stderr.on('data', (d: Buffer) => stderrChunks.push(Buffer.from(d)));

      const done = await new Promise<{ code: number | null }>((resolve, reject) => {
        const t = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, timeoutMs);
        child.once('error', (err) => {
          clearTimeout(t);
          reject(err);
        });
        child.once('close', (code) => {
          clearTimeout(t);
          resolve({ code });
        });
      });

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
      if (done.code !== 0) continue;

      let summary = stdout.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!summary) summary = stderr.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!summary) {
        return { ok: false, provider: 'claude', latencyMs: Date.now() - start, error: 'Empty summary from claude' };
      }
      return { ok: true, provider: 'claude', latencyMs: Date.now() - start, summary };
    } catch {
      // try next
    }
  }

  return {
    ok: false,
    provider: 'claude',
    latencyMs: Date.now() - start,
    error: 'Failed to run claude CLI (non-interactive); ensure `claude` is installed and supports `-p` or `--print`.'
  };
};

export const generateAiSummary = async (
  input: AiSummaryInput,
  options?: { model?: string; timeoutMs?: number; preferredProvider?: 'auto' | 'codex' | 'claude' }
): Promise<AiSummaryResult> => {
  const preferred = options?.preferredProvider ?? 'auto';
  const hasCodex = await isCliAvailable('codex');
  const hasClaude = await isCliAvailable('claude');

  // Requirement: if both exist, use codex.
  if (hasCodex) {
    return await generateAiSummaryWithCodex(input, options);
  }

  if (hasClaude && (preferred === 'auto' || preferred === 'claude' || preferred === 'codex')) {
    return await generateAiSummaryWithClaude(input, options);
  }

  return {
    ok: false,
    provider: preferred === 'claude' ? 'claude' : 'codex',
    latencyMs: 0,
    error: 'No supported AI CLI available. Install and login `codex` (preferred) or `claude`.'
  };
};
