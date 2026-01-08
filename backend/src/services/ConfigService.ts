import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import chokidar, { type FSWatcher } from 'chokidar';
import { addCodexMcpServer, getCodexMcpServer, listCodexMcpServers, removeCodexMcpServer } from './CodexMcpService.js';

/**
 * MCP Server 配置（符合官方 Schema）
 */
export interface MCPServerConfig {
  // stdio 模式
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  type?: string;

  // SSE 模式
  url?: string;
  headers?: Record<string, string>;

  // 启用/禁用状态
  disabled?: boolean;
}

/**
 * MCP 配置文件结构
 */
export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
  meta?: {
    serverMeta?: Record<string, { origin: 'global' | 'project' }>;
  };
}

/**
 * AI 工具配置
 */
export interface HostConfig {
  id: string;
  name: string;
  configPath: string;
  format: 'mcpServers' | 'servers' | 'claudeJson' | 'codexMcp' | 'special';
  active: boolean;
  detected?: boolean;
  lastSynced?: Date;
  scope: 'global' | 'project';  // 配置范围
  projectPath?: string;  // 项目路径（仅项目级配置）
}

/**
 * 配置文件管理服务
 */
export class ConfigService {
  private readonly claudeCodeGlobalConfigPath = '~/.claude.json';

  private hosts: HostConfig[] = [
    {
      id: 'cursor',
      name: 'Cursor',
      configPath: '~/.cursor/mcp.json',
      format: 'mcpServers',
      active: false,
      scope: 'global'
    },
    {
      id: 'vscode',
      name: 'VS Code',
      configPath: '~/Library/Application Support/Code/User/mcp.json',
      format: 'mcpServers',
      active: false,
      scope: 'global'
    },
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      configPath: '~/Library/Application Support/Claude/claude_desktop_config.json',
      format: 'mcpServers',
      active: false,
      scope: 'global'
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      configPath: '~/.claude.json',
      format: 'claudeJson',
      active: true,
      scope: 'global'
    },
    {
      id: 'copilot',
      name: 'GitHub Copilot (IntelliJ)',
      configPath: '~/.config/github-copilot/intellij/mcp.json',
      format: 'servers',
      active: false,
      scope: 'global'
    },
    {
      id: 'codex',
      name: 'Codex',
      configPath: '~/.codex/config.toml',
      format: 'codexMcp',
      active: false,
      scope: 'global'
    }
  ];

  private watchers: Map<string, FSWatcher> = new Map();
  private syncing = false;  // 防止循环同步
  private codexOpQueue: Promise<unknown> = Promise.resolve();
  private fileOpQueues: Map<string, Promise<unknown>> = new Map();

  private enqueueCodexOp<T>(task: () => Promise<T>): Promise<T> {
    const run = this.codexOpQueue.then(task, task);
    this.codexOpQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private enqueueFileOp<T>(queueKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.fileOpQueues.get(queueKey) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.fileOpQueues.set(queueKey, run.then(() => undefined, () => undefined));
    return run;
  }

  private fileOpKeyForHost(host: HostConfig): string {
    if (host.format === 'claudeJson') return this.expandHomePath(this.claudeCodeGlobalConfigPath);
    return host.scope === 'project' ? host.configPath : this.expandHomePath(host.configPath);
  }

  private async writeFileAtomic(targetPath: string, content: string): Promise<void> {
    const dir = path.dirname(targetPath);
    const base = path.basename(targetPath);
    const tmpPath = path.join(
      dir,
      `.${base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );

    await fs.writeFile(tmpPath, content, 'utf-8');

    try {
      await fs.rename(tmpPath, targetPath);
    } catch (err: any) {
      const code = err?.code;
      if (code === 'EEXIST' || code === 'EPERM' || code === 'ENOTEMPTY') {
        await fs.rm(targetPath, { force: true });
        await fs.rename(tmpPath, targetPath);
        return;
      }
      throw err;
    }
  }

  private projectHostsCache: { atMs: number; hosts: HostConfig[] } | null = null;
  private readonly projectHostsCacheTtlMs = 10_000;

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((x): x is string => typeof x === 'string');
  }

  private async writeJsonFileWithSyncGuard(configPath: string, outputJson: unknown): Promise<void> {
    this.syncing = true;
    try {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await this.writeFileAtomic(configPath, JSON.stringify(outputJson, null, 2));
    } finally {
      setTimeout(() => { this.syncing = false; }, 1000);
    }
  }

  private stripDisabledFlagForClaude(config: MCPServerConfig): MCPServerConfig {
    const next = { ...(config as any) };
    delete (next as any).disabled;
    return next as MCPServerConfig;
  }

  private extractMcpServersFromClaudeJson(json: unknown): Record<string, MCPServerConfig> {
    if (!this.isRecord(json)) return {};

    const direct = json['mcpServers'];
    if (this.isRecord(direct)) return direct as Record<string, MCPServerConfig>;

    const mcp = json['mcp'];
    if (this.isRecord(mcp)) {
      const nested = mcp['mcpServers'];
      if (this.isRecord(nested)) return nested as Record<string, MCPServerConfig>;
    }

    return {};
  }

  private extractDisabledMcpServersFromClaudeSection(section: unknown): string[] {
    if (!this.isRecord(section)) return [];
    return this.toStringArray(section['disabledMcpServers']);
  }

  private extractProjectSectionFromClaudeJson(json: unknown, projectPath: string): Record<string, unknown> | null {
    if (!this.isRecord(json)) return null;
    const root = json as Record<string, unknown>;
    const direct = root[projectPath];
    if (this.isRecord(direct)) return direct as Record<string, unknown>;
    const projectsContainer = this.isRecord(root['projects']) ? (root['projects'] as Record<string, unknown>) : null;
    const container = projectsContainer ? projectsContainer[projectPath] : undefined;
    if (this.isRecord(container)) return container as Record<string, unknown>;
    return null;
  }

  private looksLikeAbsolutePath(value: string): boolean {
    if (path.isAbsolute(value)) return true;
    // Windows: C:\... or \\server\share\...
    return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
  }

  private extractProjectMcpServersFromClaudeJson(json: unknown, projectPath: string): Record<string, MCPServerConfig> {
    if (!this.isRecord(json)) return {};
    const root = json as Record<string, unknown>;
    const directSection = root[projectPath];
    const projectsContainer = this.isRecord(root['projects']) ? (root['projects'] as Record<string, unknown>) : null;
    const containerSection = projectsContainer ? projectsContainer[projectPath] : undefined;
    const section = this.isRecord(directSection) ? directSection : containerSection;
    if (!this.isRecord(section)) return {};

    const direct = section['mcpServers'];
    if (this.isRecord(direct)) return direct as Record<string, MCPServerConfig>;

    const mcp = section['mcp'];
    if (this.isRecord(mcp)) {
      const nested = mcp['mcpServers'];
      if (this.isRecord(nested)) return nested as Record<string, MCPServerConfig>;
    }

    return {};
  }

  private writeProjectMcpServersIntoClaudeJson(
    existing: unknown,
    projectPath: string,
    mcpServers: Record<string, MCPServerConfig>
  ): any {
    const root = this.isRecord(existing) ? (existing as Record<string, unknown>) : {};
    const projectsContainer = this.isRecord(root['projects']) ? (root['projects'] as Record<string, unknown>) : null;

    const directCurrentSection = root[projectPath];
    const containerCurrentSection = projectsContainer ? projectsContainer[projectPath] : undefined;

    const existingSection = this.isRecord(directCurrentSection)
      ? (directCurrentSection as Record<string, unknown>)
      : (this.isRecord(containerCurrentSection) ? (containerCurrentSection as Record<string, unknown>) : {});

    // 保持项目 section 里其他字段（allowedTools/mcpContextUris 等），仅更新 mcpServers
    const mcp = existingSection['mcp'];
    const hasNested = this.isRecord(mcp) && this.isRecord((mcp as Record<string, unknown>)['mcpServers']) && !this.isRecord(existingSection['mcpServers']);
    const nextSection = hasNested
      ? { ...existingSection, mcp: { ...(mcp as Record<string, unknown>), mcpServers } }
      : { ...existingSection, mcpServers };

    // 优先写回到原来存在的位置：top-level key 或 projects 容器；否则若 projects 容器存在则写入其下
    if (this.isRecord(directCurrentSection)) {
      return { ...root, [projectPath]: nextSection };
    }

    if (projectsContainer) {
      return { ...root, projects: { ...projectsContainer, [projectPath]: nextSection } };
    }

    return { ...root, [projectPath]: nextSection };
  }

  private writeProjectSectionIntoClaudeJson(
    existing: unknown,
    projectPath: string,
    patch: Record<string, unknown>
  ): any {
    const root = this.isRecord(existing) ? (existing as Record<string, unknown>) : {};
    const projectsContainer = this.isRecord(root['projects']) ? (root['projects'] as Record<string, unknown>) : null;

    const directCurrentSection = root[projectPath];
    const containerCurrentSection = projectsContainer ? projectsContainer[projectPath] : undefined;

    const existingSection = this.isRecord(directCurrentSection)
      ? (directCurrentSection as Record<string, unknown>)
      : (this.isRecord(containerCurrentSection) ? (containerCurrentSection as Record<string, unknown>) : {});

    const nextSection = { ...existingSection, ...patch };

    if (this.isRecord(directCurrentSection)) {
      return { ...root, [projectPath]: nextSection };
    }

    if (projectsContainer) {
      return { ...root, projects: { ...projectsContainer, [projectPath]: nextSection } };
    }

    return { ...root, [projectPath]: nextSection };
  }

  private async detectClaudeCodeProjectConfigsFromGlobalClaudeJson(): Promise<HostConfig[]> {
    const claudePath = this.expandHomePath(this.claudeCodeGlobalConfigPath);
    try {
      const content = await fs.readFile(claudePath, 'utf-8');
      const json = JSON.parse(content);
      if (!this.isRecord(json)) return [];

      const results: HostConfig[] = [];
      const root = json as Record<string, unknown>;
      const container = this.isRecord(root['projects']) ? (root['projects'] as Record<string, unknown>) : root;

      for (const [key, value] of Object.entries(container)) {
        if (!this.looksLikeAbsolutePath(key)) continue;
        if (!this.isRecord(value)) continue;

        results.push({
          id: this.makeProjectHostId('claude-code', key),
          name: `Claude Code (项目: ${path.basename(key) || key})`,
          configPath: claudePath,
          format: 'claudeJson',
          active: false,
          detected: true,
          scope: 'project',
          projectPath: key
        });
      }

      return results;
    } catch {
      return [];
    }
  }

  private writeMcpServersIntoClaudeJson(existing: unknown, mcpServers: Record<string, MCPServerConfig>): any {
    if (!this.isRecord(existing)) return { mcpServers };

    // 如果现有结构是 { mcp: { mcpServers: ... } }，则保留该结构并仅更新 nested 字段
    const mcp = existing['mcp'];
    const hasNested = this.isRecord(mcp) && this.isRecord(mcp['mcpServers']) && !this.isRecord(existing['mcpServers']);
    if (hasNested) {
      return { ...existing, mcp: { ...(mcp as Record<string, unknown>), mcpServers } };
    }

    return { ...existing, mcpServers };
  }

  private async resolveHost(hostId: string): Promise<HostConfig> {
    const allHosts = await this.detectInstalledHosts();
    const resolved = allHosts.find(h => h.id === hostId);
    if (resolved) return resolved;

    const fallback = this.hosts.find(h => h.id === hostId);
    if (!fallback) throw new Error(`Host not found: ${hostId}`);
    return fallback;
  }

  private makeProjectHostId(prefix: string, basePath: string): string {
    const projectName = path.basename(basePath) || 'root';
    const hash = createHash('sha1').update(basePath).digest('hex').slice(0, 8);
    return `${prefix}-project-${projectName}-${hash}`;
  }

  private getDefaultProjectRoot(): string {
    try {
      const currentFile = fileURLToPath(import.meta.url);
      const currentDir = path.dirname(currentFile);
      const parsed = path.parse(currentDir);
      const segments = currentDir.slice(parsed.root.length).split(path.sep).filter(Boolean);
      const backendIndex = segments.lastIndexOf('backend');
      if (backendIndex >= 0) {
        return path.join(parsed.root, ...segments.slice(0, backendIndex));
      }

      return currentDir;
    } catch {
      const cwd = process.cwd();
      const base = path.basename(cwd);
      if (base === 'backend' || base === 'frontend') return path.resolve(cwd, '..');
      return cwd;
    }
  }

  private getProjectScanRoots(): string[] {
    const configured = process.env.MCP_PROJECT_SCAN_PATHS?.trim();
    if (configured) {
      return configured
        .split(/[,:;\n]/g)
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => path.resolve(this.expandHomePath(p)));
    }

    const projectRoot = this.getDefaultProjectRoot();
    const workspaceRoot = path.resolve(projectRoot, '..');
    return Array.from(new Set([projectRoot, workspaceRoot]));
  }

  private getProjectScanMaxDepth(): number {
    const raw = process.env.MCP_PROJECT_SCAN_MAX_DEPTH?.trim();
    const value = raw ? Number(raw) : 4;
    if (!Number.isFinite(value)) return 4;
    return Math.max(0, Math.min(12, Math.floor(value)));
  }

  private getProjectScanMaxResults(): number {
    const raw = process.env.MCP_PROJECT_SCAN_MAX_RESULTS?.trim();
    const value = raw ? Number(raw) : 300;
    if (!Number.isFinite(value)) return 300;
    return Math.max(1, Math.min(5000, Math.floor(value)));
  }

  private shouldSkipScanDirName(name: string): boolean {
    if (!name) return true;
    if (name.startsWith('.')) return true;
    return (
      name === 'node_modules' ||
      name === 'dist' ||
      name === 'build' ||
      name === 'out' ||
      name === '.next' ||
      name === '.turbo' ||
      name === '.git' ||
      name === 'coverage'
    );
  }

  private async scanForProjectConfigs(
    roots: string[],
    maxDepth: number,
    maxResults: number
  ): Promise<HostConfig[]> {
    const detected: HostConfig[] = [];
    const seenConfigPaths = new Set<string>();
    const visitedDirs = new Set<string>();

    const queue: Array<{ dir: string; depth: number }> = [];
    for (const root of roots) {
      const absoluteRoot = path.resolve(root);
      if (!visitedDirs.has(absoluteRoot)) queue.push({ dir: absoluteRoot, depth: 0 });
    }

    while (queue.length > 0 && detected.length < maxResults) {
      const current = queue.shift();
      if (!current) break;
      const { dir, depth } = current;
      if (visitedDirs.has(dir)) continue;
      visitedDirs.add(dir);

      let entries: Array<import('fs').Dirent>;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      const projectName = path.basename(dir) || dir;
      const hasCursor = entries.some(e => e.isDirectory() && e.name === '.cursor');

      if (hasCursor) {
        try {
          const cursorEntries = await fs.readdir(path.join(dir, '.cursor'), { withFileTypes: true });
          const hasCursorMcp = cursorEntries.some(e => e.isFile() && e.name === 'mcp.json');
          if (hasCursorMcp) {
            const configPath = path.resolve(dir, '.cursor', 'mcp.json');
            if (!seenConfigPaths.has(configPath)) {
              seenConfigPaths.add(configPath);
              detected.push({
                id: this.makeProjectHostId('cursor', dir),
                name: `Cursor (项目: ${projectName})`,
                configPath,
                format: 'mcpServers',
                active: false,
                detected: true,
                scope: 'project',
                projectPath: dir
              });
            }
          }
        } catch {
          // ignore
        }
      }

      if (depth >= maxDepth) continue;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.isSymbolicLink()) continue;
        if (this.shouldSkipScanDirName(entry.name)) continue;
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }

    return detected;
  }

  /**
   * 扩展 Home 路径
   */
  private expandHomePath(filePath: string): string {
    if (filePath.startsWith('~/')) {
      return path.join(homedir(), filePath.slice(2));
    }
    return filePath;
  }

  /**
   * 自动检测已安装的 AI 工具
   */
  async detectInstalledHosts(): Promise<HostConfig[]> {
    const globalHosts: HostConfig[] = [];

    // 检测全局配置
    for (const host of this.hosts) {
      // Claude Code：只使用 ~/.claude.json
      if (host.id === 'claude-code') {
        const preferred = this.expandHomePath(this.claudeCodeGlobalConfigPath);

        try {
          await fs.access(preferred);
          globalHosts.push({
            ...host,
            configPath: this.claudeCodeGlobalConfigPath,
            format: 'claudeJson',
            detected: true,
            active: false
          });
          continue;
        } catch {
          globalHosts.push({ ...host, detected: false, active: false });
          continue;
        }
      }

      const expandedPath = this.expandHomePath(host.configPath);
      try {
        await fs.access(expandedPath);
        globalHosts.push({ ...host, detected: true, active: false });
      } catch {
        globalHosts.push({ ...host, detected: false, active: false });
      }
    }

    // 检测项目级配置
    const projectHosts = await this.detectProjectConfigs();

    // 计算“默认活跃”配置源：
    // 1) 预设 active 且 detected 的全局 host
    // 2) 任意 detected 的全局 host
    // 3) 任意 detected 的项目级 host
    // 4) 回退到第一个全局 host（即使未 detected，也允许后续创建配置文件）
    const activeHostId =
      globalHosts.find(h => h.detected && this.hosts.find(x => x.id === h.id)?.active)?.id ??
      globalHosts.find(h => h.detected)?.id ??
      projectHosts.find(h => h.detected)?.id ??
      globalHosts[0]?.id;

    const allHosts: HostConfig[] = [
      ...globalHosts.map(h => ({ ...h, active: h.id === activeHostId })),
      ...projectHosts.map(h => ({ ...h, active: h.id === activeHostId }))
    ];

    return allHosts;
  }

  /**
   * 检测项目级配置文件
   */
  async detectProjectConfigs(): Promise<HostConfig[]> {
    const now = Date.now();
    if (this.projectHostsCache && now - this.projectHostsCache.atMs < this.projectHostsCacheTtlMs) {
      return this.projectHostsCache.hosts;
    }

    const roots = this.getProjectScanRoots();
    const maxDepth = this.getProjectScanMaxDepth();
    const maxResults = this.getProjectScanMaxResults();
    const detected = await this.scanForProjectConfigs(roots, maxDepth, maxResults);
    const claudeProjects = await this.detectClaudeCodeProjectConfigsFromGlobalClaudeJson();
    detected.push(...claudeProjects);

    this.projectHostsCache = { atMs: now, hosts: detected };
    return detected;
  }

  /**
   * 获取所有宿主配置
   */
  async getHosts(): Promise<HostConfig[]> {
    return this.detectInstalledHosts();
  }

  /**
   * 读取指定工具的配置（兼容不同格式）
   */
  async readConfig(hostId: string): Promise<MCPConfig> {
    const host = await this.resolveHost(hostId);

    // 项目级配置使用绝对路径，用户级配置需要扩展 ~
    const configPath = host.scope === 'project'
      ? host.configPath
      : this.expandHomePath(host.configPath);

    try {
      if (host.format === 'codexMcp') {
        const names = await listCodexMcpServers();
        const entries = await Promise.all(
          names.map(async (name) => {
            const config = await getCodexMcpServer(name);
            return [name, config] as const;
          })
        );
        return { mcpServers: Object.fromEntries(entries) };
      }

      const content = await fs.readFile(configPath, 'utf-8');
      const json = JSON.parse(content);

      if (host.format === 'servers') {
        // 转换 GitHub Copilot 格式
        return {
          mcpServers: json.servers || {}
        };
      }

      if (host.format === 'claudeJson') {
        // Claude Code:
        // - 用户级 MCP: root.mcpServers
        // - 项目级 MCP: projects[absPath].mcpServers (或 top-level absPath key)
        // - 启用/禁用仅对“项目级”生效：projects[absPath].disabledMcpServers
        if (host.scope === 'project' && host.projectPath) {
          const globalServers = this.extractMcpServersFromClaudeJson(json);
          const projectServers = this.extractProjectMcpServersFromClaudeJson(json, host.projectPath);

          const section = this.extractProjectSectionFromClaudeJson(json, host.projectPath);
          const disabled = new Set(this.extractDisabledMcpServersFromClaudeSection(section));

          const merged: Record<string, MCPServerConfig> = {};
          const serverMeta: Record<string, { origin: 'global' | 'project' }> = {};

          for (const [id, cfg] of Object.entries(globalServers ?? {})) {
            merged[id] = { ...(cfg as any), disabled: disabled.has(id) };
            serverMeta[id] = { origin: 'global' };
          }

          for (const [id, cfg] of Object.entries(projectServers ?? {})) {
            merged[id] = { ...(cfg as any), disabled: disabled.has(id) };
            serverMeta[id] = { origin: 'project' };
          }

          return { mcpServers: merged, meta: { serverMeta } };
        }

        return {
          // 用户级不展示启用/禁用（即便存在 disabledMcpServers，也忽略）
          mcpServers: this.extractMcpServersFromClaudeJson(json)
        };
      }

      return {
        mcpServers: json.mcpServers || {}
      };
    } catch (error) {
      // 文件不存在或解析失败，返回空配置
      console.error(`Failed to read config for ${hostId}:`, error);
      return { mcpServers: {} };
    }
  }

  /**
   * 写入配置到指定工具（自动转换格式）
   */
  async writeConfig(hostId: string, config: MCPConfig): Promise<void> {
    const host = await this.resolveHost(hostId);

    // 项目级配置使用绝对路径，用户级配置需要扩展 ~
    const configPath = host.scope === 'project'
      ? host.configPath
      : this.expandHomePath(host.configPath);

    if (host.format === 'codexMcp') {
      throw new Error('Codex host does not support writeConfig; use add/update/delete APIs');
    }

    this.syncing = true;  // 标记同步状态

    try {
      // 确保目录存在
      await fs.mkdir(path.dirname(configPath), { recursive: true });

      let outputJson: any;

      if (host.format === 'servers') {
        // 转换为 GitHub Copilot 格式
        outputJson = {
          servers: config.mcpServers
        };
      } else if (host.format === 'claudeJson') {
        // Claude Code 的 .claude.json 可能包含其他配置；仅更新 MCP 相关字段，保留其他字段
        try {
          const existing = await fs.readFile(configPath, 'utf-8');
          const existingJson = JSON.parse(existing);
          outputJson = host.scope === 'project' && host.projectPath
            ? this.writeProjectMcpServersIntoClaudeJson(existingJson, host.projectPath, config.mcpServers)
            : this.writeMcpServersIntoClaudeJson(existingJson, config.mcpServers);
        } catch {
          outputJson = host.scope === 'project' && host.projectPath
            ? this.writeProjectMcpServersIntoClaudeJson({}, host.projectPath, config.mcpServers)
            : { mcpServers: config.mcpServers };
        }
      } else {
        outputJson = {
          mcpServers: config.mcpServers
        };
      }

      await this.writeFileAtomic(configPath, JSON.stringify(outputJson, null, 2));
    } finally {
      // 延迟重置同步标记，避免立即触发 watcher
      setTimeout(() => { this.syncing = false; }, 1000);
    }
  }

  /**
   * 同步配置到多个工具
   */
  async syncToHosts(sourceHostId: string, targetHostIds: string[]): Promise<void> {
    const config = await this.readConfig(sourceHostId);

    await Promise.all(
      targetHostIds.map(targetId => this.writeConfig(targetId, config))
    );
  }

  /**
   * 监听配置文件变更
   */
  async watchConfig(hostId: string, onChange: (config: MCPConfig) => void): Promise<void> {
    const host = await this.resolveHost(hostId);

    const expandedPath = host.scope === 'project'
      ? host.configPath
      : this.expandHomePath(host.configPath);

    const watcher = chokidar.watch(expandedPath, {
      persistent: true,
      ignoreInitial: true
    });

    watcher.on('change', async () => {
      if (this.syncing) return;  // 跳过同步期间的变更

      const config = await this.readConfig(hostId);
      onChange(config);
    });

    this.watchers.set(hostId, watcher);
  }

  /**
   * 停止监听
   */
  async unwatchConfig(hostId: string): Promise<void> {
    const watcher = this.watchers.get(hostId);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(hostId);
    }
  }

  /**
   * 关闭所有监听器
   */
  async closeAll(): Promise<void> {
    for (const [, watcher] of this.watchers) {
      await watcher.close();
    }
    this.watchers.clear();
  }

  /**
   * 添加 MCP 服务器
   */
  async addMCP(hostId: string, mcpId: string, config: MCPServerConfig): Promise<void> {
    const host = await this.resolveHost(hostId);
    if (host.format === 'codexMcp') {
      // 备份当前配置
      await this.backupConfig(hostId);
      await this.enqueueCodexOp(() => addCodexMcpServer(mcpId, config));
      return;
    }

    const queueKey = this.fileOpKeyForHost(host);
    await this.enqueueFileOp(queueKey, async () => {
      // 备份当前配置
      await this.backupConfig(hostId);

      if (host.format === 'claudeJson') {
        const sanitized = this.stripDisabledFlagForClaude(config);
        const configPath = this.expandHomePath(this.claudeCodeGlobalConfigPath);
        let existingJson: unknown = {};
        try {
          const existing = await fs.readFile(configPath, 'utf-8');
          existingJson = JSON.parse(existing);
        } catch {
          existingJson = {};
        }

        if (host.scope === 'project' && host.projectPath) {
          const projectServers = this.extractProjectMcpServersFromClaudeJson(existingJson, host.projectPath);
          if (projectServers[mcpId]) {
            throw new Error(`MCP server "${mcpId}" already exists in this project`);
          }
          const nextProjectServers = { ...projectServers, [mcpId]: sanitized };
          const outputJson = this.writeProjectMcpServersIntoClaudeJson(existingJson, host.projectPath, nextProjectServers);
          await this.writeJsonFileWithSyncGuard(configPath, outputJson);
          return;
        }

        const servers = this.extractMcpServersFromClaudeJson(existingJson);
        if (servers[mcpId]) {
          throw new Error(`MCP server "${mcpId}" already exists`);
        }
        const nextServers = { ...servers, [mcpId]: sanitized };
        const outputJson = this.writeMcpServersIntoClaudeJson(existingJson, nextServers);
        await this.writeJsonFileWithSyncGuard(configPath, outputJson);
        return;
      }

      // 读取当前配置
      const currentConfig = await this.readConfig(hostId);

      // 检查是否已存在
      if (currentConfig.mcpServers[mcpId]) {
        throw new Error(`MCP server "${mcpId}" already exists`);
      }

      // 添加新 MCP
      currentConfig.mcpServers[mcpId] = config;

      // 写入配置
      await this.writeConfig(hostId, currentConfig);
    });
  }

  /**
   * 更新 MCP 服务器
   */
  async updateMCP(hostId: string, mcpId: string, config: MCPServerConfig): Promise<void> {
    const host = await this.resolveHost(hostId);
    if (host.format === 'codexMcp') {
      // 备份当前配置
      await this.backupConfig(hostId);
      await this.enqueueCodexOp(async () => {
        // Codex CLI does not have an update command; emulate via remove+add.
        await removeCodexMcpServer(mcpId);
        await addCodexMcpServer(mcpId, config);
      });
      return;
    }

    const queueKey = this.fileOpKeyForHost(host);
    await this.enqueueFileOp(queueKey, async () => {
      // 备份当前配置
      await this.backupConfig(hostId);

      if (host.format === 'claudeJson') {
        const sanitized = this.stripDisabledFlagForClaude(config);
        const configPath = this.expandHomePath(this.claudeCodeGlobalConfigPath);
        let existingJson: unknown = {};
        try {
          const existing = await fs.readFile(configPath, 'utf-8');
          existingJson = JSON.parse(existing);
        } catch {
          existingJson = {};
        }

        if (host.scope === 'project' && host.projectPath) {
          const projectServers = this.extractProjectMcpServersFromClaudeJson(existingJson, host.projectPath);
          if (!projectServers[mcpId]) {
            throw new Error(`MCP server "${mcpId}" is not a project override (inherited from global); switch to Claude Code (用户) to edit`);
          }
          const nextProjectServers = { ...projectServers, [mcpId]: sanitized };
          const outputJson = this.writeProjectMcpServersIntoClaudeJson(existingJson, host.projectPath, nextProjectServers);
          await this.writeJsonFileWithSyncGuard(configPath, outputJson);
          return;
        }

        const servers = this.extractMcpServersFromClaudeJson(existingJson);
        if (!servers[mcpId]) {
          throw new Error(`MCP server "${mcpId}" not found`);
        }
        const nextServers = { ...servers, [mcpId]: sanitized };
        const outputJson = this.writeMcpServersIntoClaudeJson(existingJson, nextServers);
        await this.writeJsonFileWithSyncGuard(configPath, outputJson);
        return;
      }

      // 读取当前配置
      const currentConfig = await this.readConfig(hostId);

      // 检查是否存在
      if (!currentConfig.mcpServers[mcpId]) {
        throw new Error(`MCP server "${mcpId}" not found`);
      }

      // 更新配置
      currentConfig.mcpServers[mcpId] = config;

      // 写入配置
      await this.writeConfig(hostId, currentConfig);
    });
  }

  /**
   * 删除 MCP 服务器
   */
  async deleteMCP(hostId: string, mcpId: string): Promise<void> {
    const host = await this.resolveHost(hostId);
    if (host.format === 'codexMcp') {
      // 备份当前配置
      await this.backupConfig(hostId);
      await this.enqueueCodexOp(() => removeCodexMcpServer(mcpId));
      return;
    }

    const queueKey = this.fileOpKeyForHost(host);
    await this.enqueueFileOp(queueKey, async () => {
      // 备份当前配置
      await this.backupConfig(hostId);

      if (host.format === 'claudeJson') {
        const configPath = this.expandHomePath(this.claudeCodeGlobalConfigPath);
        let existingJson: unknown = {};
        try {
          const existing = await fs.readFile(configPath, 'utf-8');
          existingJson = JSON.parse(existing);
        } catch {
          existingJson = {};
        }

        if (host.scope === 'project' && host.projectPath) {
          const projectServers = this.extractProjectMcpServersFromClaudeJson(existingJson, host.projectPath);
          if (!projectServers[mcpId]) {
            throw new Error(`MCP server "${mcpId}" not found in this project's overrides`);
          }
          const nextProjectServers = { ...projectServers };
          delete nextProjectServers[mcpId];
          const outputJson = this.writeProjectMcpServersIntoClaudeJson(existingJson, host.projectPath, nextProjectServers);
          await this.writeJsonFileWithSyncGuard(configPath, outputJson);
          return;
        }

        const servers = this.extractMcpServersFromClaudeJson(existingJson);
        if (!servers[mcpId]) {
          throw new Error(`MCP server "${mcpId}" not found`);
        }
        const nextServers = { ...servers };
        delete nextServers[mcpId];
        const outputJson = this.writeMcpServersIntoClaudeJson(existingJson, nextServers);
        await this.writeJsonFileWithSyncGuard(configPath, outputJson);
        return;
      }

      // 读取当前配置
      const currentConfig = await this.readConfig(hostId);

      // 检查是否存在
      if (!currentConfig.mcpServers[mcpId]) {
        throw new Error(`MCP server "${mcpId}" not found`);
      }

      // 删除 MCP
      delete currentConfig.mcpServers[mcpId];

      // 写入配置
      await this.writeConfig(hostId, currentConfig);
    });
  }

  /**
   * 切换 MCP 服务器启用/禁用状态
   */
  async toggleMCP(hostId: string, mcpId: string): Promise<boolean> {
    const host = await this.resolveHost(hostId);
    if (host.format === 'codexMcp') {
      // 备份当前配置
      await this.backupConfig(hostId);
      return await this.enqueueCodexOp(async () => {
        const configPath = this.expandHomePath(host.configPath);
        this.syncing = true;
        try {
          const enabled = await this.toggleCodexMcpEnabledInToml(configPath, mcpId);
          return enabled;
        } finally {
          setTimeout(() => { this.syncing = false; }, 1000);
        }
      });
    }

    const queueKey = this.fileOpKeyForHost(host);
    return await this.enqueueFileOp(queueKey, async () => {
      // 备份当前配置
      await this.backupConfig(hostId);

      if (host.format === 'claudeJson') {
        const configPath = this.expandHomePath(this.claudeCodeGlobalConfigPath);
        let existingJson: unknown = {};
        try {
          const existing = await fs.readFile(configPath, 'utf-8');
          existingJson = JSON.parse(existing);
        } catch {
          existingJson = {};
        }

        if (host.scope === 'project' && host.projectPath) {
          const globalServers = this.extractMcpServersFromClaudeJson(existingJson);
          const projectServers = this.extractProjectMcpServersFromClaudeJson(existingJson, host.projectPath);
          if (!globalServers[mcpId] && !projectServers[mcpId]) {
            throw new Error(`MCP server "${mcpId}" not found`);
          }

          const section = this.extractProjectSectionFromClaudeJson(existingJson, host.projectPath);
          const current = this.extractDisabledMcpServersFromClaudeSection(section);
          const isDisabled = current.includes(mcpId);
          const next = isDisabled ? current.filter(x => x !== mcpId) : [...current, mcpId];
          const outputJson = this.writeProjectSectionIntoClaudeJson(existingJson, host.projectPath, { disabledMcpServers: next });
          await this.writeJsonFileWithSyncGuard(configPath, outputJson);
          return !next.includes(mcpId);
        }

        // 用户级不支持启用/禁用（只对项目级生效）
        throw new Error('Claude Code 用户级不支持启用/禁用，请使用项目级配置源');
      }

      // 读取当前配置
      const currentConfig = await this.readConfig(hostId);

      // 检查是否存在
      if (!currentConfig.mcpServers[mcpId]) {
        throw new Error(`MCP server "${mcpId}" not found`);
      }

      // 切换状态
      const currentStatus = currentConfig.mcpServers[mcpId].disabled || false;
      currentConfig.mcpServers[mcpId].disabled = !currentStatus;

      // 写入配置
      await this.writeConfig(hostId, currentConfig);

      // 返回新状态（true 表示已启用，false 表示已禁用）
      return !currentConfig.mcpServers[mcpId].disabled;
    });
  }

  private tomlEscapeBasicString(value: string): string {
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t');
  }

  private codexTomlServerHeaderCandidates(mcpId: string): string[] {
    const id = String(mcpId);
    const safe = /^[A-Za-z0-9_-]+$/.test(id);
    const quoted = `"${this.tomlEscapeBasicString(id)}"`;
    const singleQuoted = `'${id.replace(/'/g, "''")}'`;
    return safe
      ? [`[mcp_servers.${id}]`, `[mcp_servers.${quoted}]`, `[mcp_servers.${singleQuoted}]`]
      : [`[mcp_servers.${quoted}]`, `[mcp_servers.${singleQuoted}]`, `[mcp_servers.${id}]`];
  }

  private async toggleCodexMcpEnabledInToml(configPath: string, mcpId: string): Promise<boolean> {
    let content: string;
    try {
      content = await fs.readFile(configPath, 'utf-8');
    } catch {
      throw new Error('Codex 配置文件不存在（~/.codex/config.toml）');
    }

    const hasTrailingNewline = content.endsWith('\n');
    const lines = content.split(/\r?\n/);

    const candidates = this.codexTomlServerHeaderCandidates(mcpId).map(s => s.trim());
    const startIdx = lines.findIndex(line => candidates.includes(line.trim()));
    if (startIdx === -1) {
      throw new Error(`MCP server "${mcpId}" not found`);
    }

    // Base table ends before the first next table header (including subtables).
    let baseEnd = startIdx + 1;
    while (baseEnd < lines.length) {
      const t = lines[baseEnd].trim();
      if (/^\[.*\]\s*$/.test(t)) break;
      baseEnd += 1;
    }

    const enabledLineRe = /^\s*enabled\s*=\s*(true|false)\s*(#.*)?$/i;
    let enabledLineIdx = -1;
    let currentEnabled = true; // default for Codex when field absent

    for (let i = startIdx + 1; i < baseEnd; i += 1) {
      const m = lines[i].match(enabledLineRe);
      if (!m) continue;
      enabledLineIdx = i;
      currentEnabled = String(m[1]).toLowerCase() === 'true';
      break;
    }

    const nextEnabled = !currentEnabled;
    const nextLine = `enabled = ${nextEnabled ? 'true' : 'false'}`;

    if (enabledLineIdx !== -1) {
      const commentMatch = lines[enabledLineIdx].match(enabledLineRe);
      const comment = commentMatch?.[2] ? ` ${commentMatch[2].trim()}` : '';
      lines[enabledLineIdx] = `${nextLine}${comment}`.trimEnd();
    } else {
      lines.splice(startIdx + 1, 0, nextLine);
    }

    const nextContent = lines.join('\n') + (hasTrailingNewline ? '\n' : '');
    await fs.writeFile(configPath, nextContent, 'utf-8');
    return nextEnabled;
  }

  /**
   * 备份配置文件
   */
  async backupConfig(hostId: string): Promise<void> {
    let host: HostConfig;
    try {
      host = await this.resolveHost(hostId);
    } catch {
      return;
    }

    // 项目级配置使用绝对路径，用户级配置需要扩展 ~
    const configPath = host.scope === 'project'
      ? host.configPath
      : this.expandHomePath(host.configPath);

    try {
      const content = await fs.readFile(configPath, 'utf-8');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = path.join(process.cwd(), '../data/backups');
      await fs.mkdir(backupDir, { recursive: true });

      const backupPath = path.join(backupDir, `${host.id}_${timestamp}.json`);
      await fs.writeFile(backupPath, content);

      console.log(`Backup created: ${backupPath}`);
    } catch (error) {
      console.error(`Failed to backup config for ${hostId}:`, error);
    }
  }
}

// 导出单例
export const configService = new ConfigService();
