import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { McpCapabilitiesResult } from './McpCapabilitiesService.js';

type CacheEntry = {
  hostId: string;
  mcpId: string;
  cachedAt: number;
  ttlMs: number;
  result: McpCapabilitiesResult;
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

const safeSegment = (value: string) => String(value).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120) || 'unknown';

const idHash = (value: string) => createHash('sha1').update(String(value)).digest('hex').slice(0, 10);

export const capabilitiesOkTtlMs = 7 * 24 * 60 * 60 * 1000;

const maxCacheChars = 900_000;

const shrinkResultForCache = (result: McpCapabilitiesResult): McpCapabilitiesResult => {
  if (!result.ok) return result;

  const tools = Array.isArray(result.capabilities?.tools) ? result.capabilities.tools : [];
  const resources = Array.isArray(result.capabilities?.resources) ? result.capabilities.resources : [];
  const prompts = Array.isArray(result.capabilities?.prompts) ? result.capabilities.prompts : [];

  const base: McpCapabilitiesResult = {
    ...result,
    capabilities: {
      tools: tools.slice(0, 200),
      resources,
      prompts
    }
  };

  try {
    if (JSON.stringify(base).length <= maxCacheChars) return base;
  } catch {
    // ignore
  }

  // Too big: drop inputSchema + resources/prompts.
  return {
    ...result,
    capabilities: {
      tools: tools.slice(0, 200).map(t => ({ name: t.name, description: t.description })),
      resources: [],
      prompts: []
    }
  };
};

const cachePathFor = async (hostId: string, mcpId: string): Promise<string> => {
  const root = await getRuntimeCacheDir();
  const dir = path.join(root, 'capabilities', safeSegment(hostId));
  await ensureDir(dir);
  const file = `${safeSegment(mcpId)}-${idHash(mcpId)}.json`;
  return path.join(dir, file);
};

export const readCapabilitiesCache = async (hostId: string, mcpId: string): Promise<McpCapabilitiesResult | null> => {
  try {
    const filePath = await cachePathFor(hostId, mcpId);
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as CacheEntry;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.result || parsed.result.ok !== true) return null;
    const cachedAt = Number(parsed.cachedAt ?? 0);
    const ttlMs = Number(parsed.ttlMs ?? 0);
    if (!Number.isFinite(cachedAt) || !Number.isFinite(ttlMs) || cachedAt <= 0 || ttlMs <= 0) return null;
    if (Date.now() - cachedAt > ttlMs) return null;
    return parsed.result ?? null;
  } catch {
    return null;
  }
};

export const readCapabilitiesCacheEntry = async (hostId: string, mcpId: string): Promise<Pick<CacheEntry, 'cachedAt' | 'ttlMs' | 'result'> | null> => {
  try {
    const filePath = await cachePathFor(hostId, mcpId);
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as CacheEntry;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.result || parsed.result.ok !== true) return null;
    const cachedAt = Number(parsed.cachedAt ?? 0);
    const ttlMs = Number(parsed.ttlMs ?? 0);
    if (!Number.isFinite(cachedAt) || !Number.isFinite(ttlMs) || cachedAt <= 0 || ttlMs <= 0) return null;
    if (Date.now() - cachedAt > ttlMs) return null;
    return { cachedAt, ttlMs, result: parsed.result };
  } catch {
    return null;
  }
};

export const writeCapabilitiesCache = async (hostId: string, mcpId: string, result: McpCapabilitiesResult): Promise<void> => {
  // Per requirement: do not cache failures.
  if (!result.ok) return;

  const filePath = await cachePathFor(hostId, mcpId);
  const entry: CacheEntry = {
    hostId,
    mcpId,
    cachedAt: Date.now(),
    ttlMs: capabilitiesOkTtlMs,
    result: shrinkResultForCache(result)
  };

  const content = JSON.stringify(entry, null, 2);
  if (content.length > maxCacheChars) return;

  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, filePath);
};
