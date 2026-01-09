import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

const expandHomePath = (p: string): string => {
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
};

const isSensitiveKey = (key: string): boolean => /(password|passwd|pwd|secret|token|api[_-]?key|bearer)/i.test(key);

const deepRedact = (value: unknown, parentKey?: string): unknown => {
  if (Array.isArray(value)) return value.map(v => deepRedact(v, parentKey));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && parentKey && isSensitiveKey(parentKey)) return '***';
    return value;
  }

  const obj = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'env' && v && typeof v === 'object' && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      for (const [ek] of Object.entries(v as Record<string, unknown>)) out[ek] = '***';
      next[k] = out;
      continue;
    }
    if (k === 'headers' && v && typeof v === 'object' && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      for (const [hk, hv] of Object.entries(v as Record<string, unknown>)) {
        if (hk === 'x-codex-bearer-token-env-var' && typeof hv === 'string') out[hk] = hv;
        else out[hk] = '***';
      }
      next[k] = out;
      continue;
    }
    if (isSensitiveKey(k)) {
      next[k] = (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') ? '***' : '***';
      continue;
    }
    next[k] = deepRedact(v, k);
  }
  return next;
};

export const readHostConfigFile = async (configPath: string) => {
  const resolved = expandHomePath(configPath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`Not a file: ${resolved}`);
  if (stat.size > 2 * 1024 * 1024) throw new Error(`File too large (>2MB): ${resolved}`);

  const content = await fs.readFile(resolved, 'utf-8');
  const ext = path.extname(resolved).toLowerCase();
  const language =
    ext === '.json' ? 'json'
      : ext === '.toml' ? 'toml'
        : ext === '.yaml' || ext === '.yml' ? 'yaml'
          : 'text';

  return { path: resolved, language, content };
};
