import { useMemo, useRef, useState, useEffect } from 'react';
import { Alert, Button, Card, Checkbox, Collapse, ConfigProvider, Drawer, Dropdown, Empty, FloatButton, Input, Layout, List, message, Modal, Popover, Progress, Segmented, Select, Space, Spin, Switch, Tabs, Tag, Tooltip, Typography, theme as antdTheme } from 'antd';
import { AppstoreOutlined, CheckCircleOutlined, CheckSquareOutlined, ClearOutlined, ClockCircleOutlined, CloseCircleOutlined, CloseOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, ExportOutlined, FileTextOutlined, FolderOpenOutlined, LockOutlined, MoreOutlined, MoonFilled, OrderedListOutlined, PlayCircleOutlined, PlusOutlined, ProfileOutlined, RedoOutlined, ReloadOutlined, RobotOutlined, SearchOutlined, SettingOutlined, StarFilled, StarOutlined, StopOutlined, SunFilled, UnlockOutlined, UpOutlined } from '@ant-design/icons';
import Editor from '@monaco-editor/react';
import { mcpApi } from './services/api';
import { MCPForm } from './components/MCPForm';
import { MarketplaceDrawer, type MarketplaceTemplate } from './components/MarketplaceDrawer';
import './App.css';

const { Title, Text } = Typography;
const { Header, Content, Footer } = Layout;

const toTildePath = (p?: string): string => {
  const raw = String(p ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('~/')) return raw;
  if (/^\/Users\/[^/]+\//.test(raw)) return raw.replace(/^\/Users\/[^/]+\//, '~/');
  if (/^\/home\/[^/]+\//.test(raw)) return raw.replace(/^\/home\/[^/]+\//, '~/');
  if (/^[A-Za-z]:\\Users\\[^\\]+\\/.test(raw)) return raw.replace(/^[A-Za-z]:\\Users\\[^\\]+\\/, '~\\');
  return raw;
};

interface MCPServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
  disabled?: boolean;
}

type McpTool = { name: string; description?: string; inputSchema?: unknown };
type McpCapabilities = { tools: McpTool[]; resources: unknown[]; prompts: unknown[] };
type McpCapabilitiesResult =
  | { ok: true; latencyMs: number; supported: { tools: boolean; resources: boolean; prompts: boolean }; capabilities: McpCapabilities }
  | { ok: false; latencyMs: number; error: string };

type McpCapabilitiesCacheEntry = { cachedAt: number; ttlMs?: number; result: McpCapabilitiesResult };
type McpCapabilitiesCacheMeta = { cachedAt: number; ttlMs: number; hit?: boolean };
type FeaturedTemplateEntry = MarketplaceTemplate & { addedAt: number };

interface HostInfo {
  id: string;
  name: string;
  configPath: string;
  format: string;
  active: boolean;
  detected: boolean;
  scope: 'global' | 'project';
  projectPath?: string;
}

type SummarySource = 'manual' | 'inferred';
type SummaryEntry = { text: string; source: SummarySource; updatedAt: number };
type SummariesMap = Record<string, SummaryEntry>;

function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [servers, setServers] = useState<Record<string, MCPServer>>({});
  const [serverMeta, setServerMeta] = useState<Record<string, { origin: 'global' | 'project' }> | null>(null);
  const [, setCurrentHost] = useState<string>('');
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [selectedTool, setSelectedTool] = useState<string>('claude-code');
  const [selectedHost, setSelectedHost] = useState<string>('');  // 当前选中的 host
  const [onlyShowConfiguredTools, setOnlyShowConfiguredTools] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('mcp.onlyShowConfiguredTools');
      // default on (reduce noise); users can toggle off to see all.
      return raw !== 'false';
    } catch {
      return true;
    }
  });
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [enabledFilter, setEnabledFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'stdio' | 'sse' | 'http'>('all');
  const [details, setDetails] = useState<{ id: string; config: MCPServer; summaryHostId: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [health, setHealth] = useState<Record<string, { status: 'unknown' | 'checking' | 'ok' | 'fail'; latencyMs?: number; error?: string; checkedAt?: number }>>({});
  const [checkRun, setCheckRun] = useState<{ running: boolean; total: number; done: number; controller: AbortController | null }>({
    running: false,
    total: 0,
    done: 0,
    controller: null
  });
  const [rowProgress, setRowProgress] = useState<Record<string, number>>({});
  const progressTimersRef = useRef<Map<string, number>>(new Map());
  const [marketOpen, setMarketOpen] = useState(false);
  const [featuredTemplates, setFeaturedTemplates] = useState<FeaturedTemplateEntry[]>(() => {
    try {
      const raw = localStorage.getItem('mcp.marketplaceFeaturedTemplates:v1');
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((t: any) => t && typeof t === 'object')
        .map((t: any) => ({
          id: String(t.id ?? ''),
          name: String(t.name ?? t.id ?? ''),
          description: typeof t.description === 'string' ? t.description : '',
          tags: Array.isArray(t.tags) ? t.tags.map((x: any) => String(x)).filter(Boolean) : [],
          json: t.json,
          addedAt: Number(t.addedAt ?? 0)
        }))
        .filter((t: FeaturedTemplateEntry) => !!t.id && !!t.json && Number.isFinite(t.addedAt) && t.addedAt > 0)
        .sort((a, b) => b.addedAt - a.addedAt)
        .slice(0, 50);
    } catch {
      return [];
    }
  });
  const [showInherited, setShowInherited] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('mcp.showInherited');
      return raw === 'true';
    } catch {
      return false;
    }
  });
  const [showSecrets, setShowSecrets] = useState<boolean>(() => {
    try {
      return localStorage.getItem('mcp.showSecrets') === 'true';
    } catch {
      return false;
    }
  });
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('mcp.darkMode');
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false;
    } catch {
      return false;
    }
  });
  const [pinnedHostIds, setPinnedHostIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('mcp.pinnedHostIds');
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((x: any) => typeof x === 'string'));
    } catch {
      return new Set();
    }
  });
  const [recentHostIds, setRecentHostIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('mcp.recentHostIds');
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((x: any) => typeof x === 'string');
    } catch {
      return [];
    }
  });
  const [bulkExport, setBulkExport] = useState<{ title: string; rawText: string; redactedText: string; language: string } | null>(null);
  const [expandedErrorIds, setExpandedErrorIds] = useState<Set<string>>(() => new Set());
  const [nowTs, setNowTs] = useState<number>(() => Date.now());
  const [configSourceSearch, setConfigSourceSearch] = useState<string>('');
  const [lastUsedAt, setLastUsedAt] = useState<Record<string, number>>(() => ({}));
  const [summariesByHost, setSummariesByHost] = useState<Record<string, SummariesMap>>(() => ({}));
  const [summaryDraft, setSummaryDraft] = useState<string>('');
  const skipNextSummaryAutosaveRef = useRef<boolean>(false);
  const [detailsTab, setDetailsTab] = useState<'config' | 'capabilities'>('config');
  const [capabilitiesByKey, setCapabilitiesByKey] = useState<Record<string, McpCapabilitiesResult>>(() => ({}));
  const [capabilitiesCacheMetaByKey, setCapabilitiesCacheMetaByKey] = useState<Record<string, McpCapabilitiesCacheMeta>>(() => ({}));
  const [capabilitiesLoadingKey, setCapabilitiesLoadingKey] = useState<string>('');
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false);
  const [hostConfigFileView, setHostConfigFileView] = useState<{ hostId: string; path: string; language: string; content: string } | null>(null);
  const [hostConfigFileLoading, setHostConfigFileLoading] = useState(false);
  const [scriptView, setScriptView] = useState<{
    id: string;
    scriptPath: string;
    language: string;
    content: string;
  } | null>(null);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineQuery, setOutlineQuery] = useState('');
  const [flashTarget, setFlashTarget] = useState<string>('');
  const flashTimerRef = useRef<number | null>(null);
  const configCardRef = useRef<HTMLDivElement | null>(null);
  const mcpListCardRef = useRef<HTMLDivElement | null>(null);
  const mcpCardRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  const featuredTemplateIds = useMemo(() => new Set(featuredTemplates.map(t => t.id)), [featuredTemplates]);

  // 表单状态
  const [formVisible, setFormVisible] = useState(false);
  const [formMode, setFormMode] = useState<'add' | 'edit'>('add');
  const [editingMCP, setEditingMCP] = useState<{ id: string; config: any } | undefined>();

  const lastUsedStorageKey = useMemo(() => `mcp.serverLastUsedAt:${selectedHost || 'none'}`, [selectedHost]);
  const summariesStorageKeyFor = (hostId: string) => `mcp.serverSummaries:${hostId || 'none'}`;
  const capabilitiesCacheStorageKeyFor = (hostId: string) => `mcp.capabilitiesCache:v1:${hostId || 'none'}`;
  const capabilitiesCacheOkTtlMs = 7 * 24 * 60 * 60 * 1000;

  useEffect(() => {
    const t = window.setInterval(() => setNowTs(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(lastUsedStorageKey);
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setLastUsedAt({});
        return;
      }
      const next: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) next[k] = n;
      }
      setLastUsedAt(next);
    } catch {
      setLastUsedAt({});
    }
  }, [lastUsedStorageKey]);

  const readSummariesFromStorage = (hostId: string): SummariesMap => {
    try {
      const raw = localStorage.getItem(summariesStorageKeyFor(hostId));
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const next: SummariesMap = {};
      for (const [k, v] of Object.entries(parsed as any)) {
        if (!v || typeof v !== 'object') continue;
        const text = String((v as any).text ?? '').trim();
        if (!text) continue;
        const source = (v as any).source === 'manual' ? 'manual' : 'inferred';
        const updatedAt = Number((v as any).updatedAt ?? 0);
        next[k] = { text, source, updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now() };
      }
      return next;
    } catch {
      return {};
    }
  };

  const loadSummariesForHost = (hostId: string) => {
    if (!hostId) return;
    const next = readSummariesFromStorage(hostId);
    setSummariesByHost(prev => ({ ...prev, [hostId]: next }));
  };

  const readCapabilitiesCacheFromStorage = (hostId: string): Record<string, McpCapabilitiesCacheEntry> => {
    try {
      const raw = localStorage.getItem(capabilitiesCacheStorageKeyFor(hostId));
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

      const now = Date.now();
      const next: Record<string, McpCapabilitiesCacheEntry> = {};

      for (const [id, v] of Object.entries(parsed as any)) {
        if (!v || typeof v !== 'object') continue;
        const cachedAt = Number((v as any).cachedAt ?? 0);
        const ttlMs = Number((v as any).ttlMs ?? 0);
        const result = (v as any).result as McpCapabilitiesResult | undefined;
        if (!Number.isFinite(cachedAt) || cachedAt <= 0) continue;
        if (!result || typeof result !== 'object') continue;
        const ok = (result as any).ok === true;
        if (!ok) continue; // do not cache failures
        const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : capabilitiesCacheOkTtlMs;
        if (now - cachedAt > ttl) continue;
        next[id] = { cachedAt, ttlMs: ttl, result };
      }

      return next;
    } catch {
      return {};
    }
  };

  const saveCapabilitiesCacheToStorage = (hostId: string, cache: Record<string, McpCapabilitiesCacheEntry>) => {
    try {
      localStorage.setItem(capabilitiesCacheStorageKeyFor(hostId), JSON.stringify(cache));
    } catch {
      // ignore (quota etc.)
    }
  };

  const storableCapabilitiesResult = (result: McpCapabilitiesResult): McpCapabilitiesResult => {
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
      const raw = JSON.stringify(base);
      if (raw.length <= 700_000) return base;
    } catch {
      // ignore
    }

    // Fallback: drop inputSchema to reduce size.
    return {
      ...result,
      capabilities: {
        tools: tools.slice(0, 200).map(t => ({ name: t.name, description: t.description })),
        resources: [],
        prompts: []
      }
    };
  };

  const loadCapabilitiesCacheForHost = (hostId: string) => {
    if (!hostId) return;
    const cache = readCapabilitiesCacheFromStorage(hostId);
    const entries = Object.entries(cache);
    if (entries.length === 0) return;

    setCapabilitiesByKey(prev => {
      const next = { ...prev };
      for (const [id, entry] of entries) {
        next[`${hostId}:${id}`] = entry.result;
      }
      return next;
    });

    setCapabilitiesCacheMetaByKey(prev => {
      const next = { ...prev };
      for (const [id, entry] of entries) {
        const ttlMs = Number(entry.ttlMs ?? capabilitiesCacheOkTtlMs);
        next[`${hostId}:${id}`] = { cachedAt: entry.cachedAt, ttlMs };
      }
      return next;
    });
  };

  useEffect(() => {
    if (!selectedHost) return;
    loadSummariesForHost(selectedHost);
  }, [selectedHost]);

  useEffect(() => {
    if (!selectedHost) return;
    loadCapabilitiesCacheForHost(selectedHost);
  }, [selectedHost]);

  useEffect(() => {
    loadMCPData();
  }, [selectedHost]);  // 当 selectedHost 变化时重新加载数据

  useEffect(() => {
    setHealth({});
    setSelectedIds(new Set());
    setExpandedErrorIds(new Set());
    setRowProgress({});
    setOutlineQuery('');
    for (const [, t] of progressTimersRef.current) window.clearInterval(t);
    progressTimersRef.current.clear();
    mcpCardRefs.current.clear();
  }, [selectedHost]);

  useEffect(() => {
    if (!details) return;
    setDetailsTab('config');
  }, [details?.id, selectedHost]);

  useEffect(() => {
    try {
      localStorage.setItem('mcp.onlyShowConfiguredTools', String(onlyShowConfiguredTools));
    } catch {
      // ignore
    }
  }, [onlyShowConfiguredTools]);

  useEffect(() => {
    try {
      localStorage.setItem('mcp.showInherited', String(showInherited));
    } catch {
      // ignore
    }
  }, [showInherited]);

  useEffect(() => {
    try {
      localStorage.setItem('mcp.showSecrets', String(showSecrets));
    } catch {
      // ignore
    }
  }, [showSecrets]);

  useEffect(() => {
    try {
      localStorage.setItem('mcp.darkMode', String(darkMode));
    } catch {
      // ignore
    }
    try {
      document.body.classList.toggle('dark', darkMode);
    } catch {
      // ignore
    }
  }, [darkMode]);

  useEffect(() => {
    try {
      localStorage.setItem('mcp.pinnedHostIds', JSON.stringify(Array.from(pinnedHostIds)));
    } catch {
      // ignore
    }
  }, [pinnedHostIds]);

  useEffect(() => {
    try {
      localStorage.setItem('mcp.marketplaceFeaturedTemplates:v1', JSON.stringify(featuredTemplates));
    } catch {
      // ignore
    }
  }, [featuredTemplates]);

  useEffect(() => {
    try {
      localStorage.setItem('mcp.recentHostIds', JSON.stringify(recentHostIds));
    } catch {
      // ignore
    }
  }, [recentHostIds]);

  useEffect(() => {
    if (!selectedHost) return;
    setRecentHostIds(prev => {
      const next = [selectedHost, ...prev.filter(x => x !== selectedHost)].slice(0, 20);
      return next;
    });
  }, [selectedHost]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const isTyping =
        active?.tagName === 'INPUT' ||
        active?.tagName === 'TEXTAREA' ||
        (active as any)?.isContentEditable;
      if (isTyping) return;

      if (e.key === '/') {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if ((e.key === 'n' || e.key === 'N') && selectedHost) {
        e.preventDefault();
        handleAdd();
        return;
      }

      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        loadMCPData();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selectedHost]);

  useEffect(() => {
    setSelectedIds(prev => {
      const next = new Set<string>();
      for (const id of prev) {
        if (servers[id]) next.add(id);
      }
      return next;
    });
  }, [servers]);

  const loadMCPData = async () => {
    try {
      setLoading(true);
      const response = await mcpApi.getAll(selectedHost || undefined);
      if (response.data.success) {
        setServers(response.data.data.servers);
        setServerMeta(response.data.data.serverMeta ?? null);
        setCurrentHost(response.data.data.currentHost);
        setHosts(response.data.data.hosts);
        // 如果没有选中 host，设置为当前活跃的 host
        if (!selectedHost) {
          setSelectedHost(response.data.data.currentHost);
        }
      } else {
        setError(response.data.error || '加载失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '网络错误');
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      message.success('已复制');
    } catch {
      message.error('复制失败');
    }
  };

  const handleAdd = () => {
    setFormMode('add');
    setEditingMCP(undefined);
    setFormVisible(true);
  };

  const handleEdit = (id: string, config: MCPServer) => {
    setFormMode('edit');
    setEditingMCP({ id, config });
    setFormVisible(true);
  };

  const handleDelete = (id: string) => {
    Modal.confirm({
      title: '确认删除',
      content: `确定要删除 MCP "${id}" 吗？此操作不可恢复。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          const response = await mcpApi.delete(id, selectedHost);
          if (response.data.success) {
            message.success('删除成功');
            loadMCPData();
          } else {
            message.error(response.data.error || '删除失败');
          }
        } catch (error: any) {
          message.error(error.response?.data?.error || '删除失败');
        }
      }
    });
  };

  const isSensitiveHeaderKey = (key: string) => {
    const k = key.toLowerCase();
    if (k === 'content-type' || k === 'accept' || k === 'user-agent') return false;
    return /authorization|cookie|token|secret|api[-_]?key|session|bearer/i.test(k);
  };

  const redactConfig = (config: MCPServer): MCPServer => {
    const next: MCPServer = { ...config };
    if (next.env && typeof next.env === 'object') {
      const env: Record<string, string> = {};
      for (const k of Object.keys(next.env)) env[k] = '***';
      next.env = env;
    }
    if (next.headers && typeof next.headers === 'object') {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(next.headers)) {
        if (k === 'x-codex-bearer-token-env-var') {
          headers[k] = String(v ?? '');
          continue;
        }
        headers[k] = isSensitiveHeaderKey(k) ? '***' : String(v ?? '');
      }
      next.headers = headers;
    }
    return next;
  };

  const toJson = (value: any) => JSON.stringify(value, null, 2);

  const tomlEscape = (value: string) =>
    String(value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t');

  const tomlString = (value: string) => `"${tomlEscape(value)}"`;

  const tomlKeySegment = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key));

  const tomlArray = (values: string[]) => `[${values.map(v => tomlString(String(v))).join(', ')}]`;

  const codexTomlForServer = (id: string, cfg: MCPServer) => {
    const serverKey = tomlKeySegment(id);
    const lines: string[] = [];

    lines.push(`[mcp_servers.${serverKey}]`);
    if (cfg.disabled === true) lines.push('enabled = false');

    if (cfg.url) {
      lines.push(`url = ${tomlString(cfg.url)}`);
      const bearer = cfg.headers?.['x-codex-bearer-token-env-var'];
      if (typeof bearer === 'string' && bearer.trim()) {
        lines.push(`bearer_token_env_var = ${tomlString(bearer.trim())}`);
      }
      if (cfg.cwd) lines.push(`cwd = ${tomlString(cfg.cwd)}`);
    } else {
      if (cfg.command) lines.push(`command = ${tomlString(cfg.command)}`);
      if (cfg.args && Array.isArray(cfg.args) && cfg.args.length > 0) lines.push(`args = ${tomlArray(cfg.args)}`);
      if (cfg.cwd) lines.push(`cwd = ${tomlString(cfg.cwd)}`);
    }

    const envEntries = cfg.env && typeof cfg.env === 'object' ? Object.entries(cfg.env) : [];
    if (envEntries.length > 0) {
      lines.push('');
      lines.push(`[mcp_servers.${serverKey}.env]`);
      for (const [k, v] of envEntries.sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`${tomlKeySegment(k)} = ${tomlString(String(v ?? ''))}`);
      }
    }

    const headerEntriesRaw = cfg.headers && typeof cfg.headers === 'object' ? Object.entries(cfg.headers) : [];
    const headerEntries = headerEntriesRaw.filter(([k]) => k !== 'x-codex-bearer-token-env-var');
    if (headerEntries.length > 0) {
      lines.push('');
      lines.push(`[mcp_servers.${serverKey}.headers]`);
      for (const [k, v] of headerEntries.sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`${tomlKeySegment(k)} = ${tomlString(String(v ?? ''))}`);
      }
    }

    return lines.join('\n') + '\n';
  };

  const parseHealthError = (text?: string): { error: string; stderr: string } => {
    if (!text) return { error: '', stderr: '' };
    const sep = ' | stderr: ';
    const idx = text.indexOf(sep);
    if (idx === -1) return { error: text, stderr: '' };
    return { error: text.slice(0, idx), stderr: text.slice(idx + sep.length) };
  };

  const setShowSecretsSafely = (next: boolean) => {
    if (!next) {
      setShowSecrets(false);
      return;
    }
    Modal.confirm({
      title: '显示敏感信息',
      content: '将显示/复制/导出环境变量等敏感信息，确认继续？',
      okText: '我已知晓',
      cancelText: '取消',
      okType: 'danger',
      onOk: () => setShowSecrets(true)
    });
  };

  const openBulkExport = async (title: string, rawText: string, redactedText: string, language: string) => {
    setBulkExport({ title, rawText, redactedText, language });
  };

  const buildFeaturedTemplate = (id: string, cfg: MCPServer, summaryText?: string): FeaturedTemplateEntry => {
    const safeCfg = showSecrets ? cfg : redactConfig(cfg);
    const hostLabel = toolLabel(selectedTool);

    const descBase =
      (summaryText && summaryText.trim())
        ? summaryText.trim()
        : cfg.url
          ? `URL：${cfg.url}`
          : cfg.command
            ? `命令：${cfg.command}`
            : '自定义 MCP';

    const description = hostLabel ? `${descBase}（来自 ${hostLabel}）` : descBase;
    const tags = Array.from(new Set([
      ...(cfg.url ? ['url'] : ['stdio']),
      ...(isCodexHost ? ['codex'] : []),
      ...(isClaudeCodeHost ? ['claude'] : []),
      'local'
    ]));

    return {
      id,
      name: id,
      description,
      tags,
      json: { mcpServers: { [id]: safeCfg } },
      addedAt: Date.now()
    };
  };

  const featureMcpToMarketplace = (id: string, cfg: MCPServer, summaryText?: string) => {
    const entry = buildFeaturedTemplate(id, cfg, summaryText);
    setFeaturedTemplates(prev => [entry, ...prev.filter(t => t.id !== id)].slice(0, 50));
    message.success('已加精：已加入精选模板');
  };

  const unfeatureMcpFromMarketplace = (id: string) => {
    setFeaturedTemplates(prev => prev.filter(t => t.id !== id));
    message.success('已取消加精');
  };

  const exportSelectedAsJson = async () => {
    if (selectedIds.size === 0) {
      message.warning('请先选择要导出的 MCP');
      return;
    }
    const ids = Array.from(selectedIds).filter(id => !!servers[id]);
    const mcpServers: Record<string, MCPServer> = {};
    for (const id of ids) mcpServers[id] = servers[id];
    const raw = toJson({ mcpServers });
    const redacted = toJson({ mcpServers: Object.fromEntries(Object.entries(mcpServers).map(([k, v]) => [k, redactConfig(v)])) });
    await openBulkExport(`导出 JSON（${ids.length}）`, raw, redacted, 'json');
  };

  const exportSelectedAsInstallCommands = async () => {
    if (selectedIds.size === 0) {
      message.warning('请先选择要导出的 MCP');
      return;
    }
    if (!(isCodexHost || isClaudeCodeHost)) {
      message.warning('当前配置源不支持生成安装命令');
      return;
    }

    const ids = Array.from(selectedIds).filter(id => !!servers[id]);
    const rawLines: string[] = [];
    const redactedLines: string[] = [];
    const failed: string[] = [];

    const buildFor = (id: string, cfg: MCPServer) => {
      if (!cfg) return null;

      // Claude Code 项目级：如果是“用户继承”的条目，导出为 user scope 更贴近真实来源
      if (isClaudeCodeProjectHost && isClaudeCodeHost) {
        const origin = serverMeta?.[id]?.origin;
        if (origin === 'global') {
          const hostInfoOverride: HostInfo | undefined = selectedHostInfo
            ? { ...selectedHostInfo, id: 'claude-code', name: 'Claude Code', scope: 'global', projectPath: undefined }
            : undefined;
          return buildInstallCliCommand(id, cfg, hostInfoOverride);
        }
      }

      return buildInstallCliCommand(id, cfg, selectedHostInfo);
    };

    for (const id of ids) {
      const cfg = servers[id];
      if (!cfg) continue;
      const rawCmd = buildFor(id, cfg);
      const redactedCmd = buildFor(id, redactConfig(cfg));
      if (!rawCmd || !redactedCmd) {
        failed.push(id);
        continue;
      }
      rawLines.push(rawCmd);
      redactedLines.push(redactedCmd);
    }

    const header = `# ${toolLabel(selectedTool)} 安装命令（${rawLines.length}）`;
    const rawText = [header, ...rawLines].join('\n');
    const redactedText = [header, ...redactedLines].join('\n');
    await openBulkExport(
      `导出安装命令（成功 ${rawLines.length}${failed.length ? `，失败 ${failed.length}` : ''}）`,
      rawText,
      redactedText,
      'plaintext'
    );
    if (failed.length) message.warning(`有 ${failed.length} 个 MCP 无法生成安装命令（已跳过）`);
  };

  const handleToggle = async (id: string) => {
    if (isClaudeCodeGlobalHost) {
      message.info('Claude Code 用户级不支持启用/禁用（仅项目级生效）');
      return;
    }
    try {
      const response = await mcpApi.toggle(id, selectedHost);
      if (response.data.success) {
        message.success(response.data.enabled ? '已启用' : '已禁用');
        setServers(prev => ({
          ...prev,
          [id]: {
            ...prev[id],
            disabled: !response.data.enabled
          }
        }));
      } else {
        message.error(response.data.error || '操作失败');
      }
    } catch (error: any) {
      message.error(error.response?.data?.error || '操作失败');
    }
  };

  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const selectAllFiltered = () => {
    setSelectedIds(new Set(serverEntries.map(([id]) => id)));
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
  };

  const bulkSetEnabled = async (enabled: boolean) => {
    if (!selectedHost) {
      message.warning('请先选择配置源');
      return;
    }
    if (isClaudeCodeGlobalHost) {
      message.warning('Claude Code 用户级不支持启用/禁用（仅项目级生效）');
      return;
    }
    if (selectedIds.size === 0) {
      message.warning('请先选择要操作的 MCP');
      return;
    }

    const ids = Array.from(selectedIds);
    const toToggle = ids.filter(id => {
      const cfg = servers[id];
      if (!cfg) return false;
      const isEnabled = !cfg.disabled;
      return enabled ? !isEnabled : isEnabled;
    });

    const noOpCount = ids.length - toToggle.length;
    if (toToggle.length === 0) {
      message.info(noOpCount > 0 ? '所选 MCP 已处于目标状态' : '无可操作项');
      return;
    }

    Modal.confirm({
      title: enabled ? '批量启用' : '批量禁用',
      content: `将对 ${toToggle.length} 个 MCP 执行${enabled ? '启用' : '禁用'}${noOpCount > 0 ? `（${noOpCount} 个已是目标状态将跳过）` : ''}，是否继续？`,
      okText: '确认',
      cancelText: '取消',
      onOk: async () => {
        setBulkLoading(true);
        message.loading({ content: '批量处理中...', key: 'bulk', duration: 0 });

        const results = await Promise.allSettled(
          toToggle.map(id => mcpApi.toggle(id, selectedHost).then(res => ({ id, res })))
        );

        let successCount = 0;
        let failureCount = 0;

        setServers(prev => {
          const next = { ...prev };
          for (const r of results) {
            if (r.status === 'fulfilled') {
              const { id, res } = r.value;
              if (res.data?.success) {
                successCount += 1;
                const nextEnabled = !!res.data.enabled;
                if (next[id]) next[id] = { ...next[id], disabled: !nextEnabled };
              } else {
                failureCount += 1;
              }
            } else {
              failureCount += 1;
            }
          }
          return next;
        });

        setBulkLoading(false);
        if (failureCount === 0) {
          message.success({ content: `批量操作完成：成功 ${toToggle.length} 个`, key: 'bulk' });
        } else {
          message.warning({ content: `批量操作完成：成功 ${successCount} 个，失败 ${failureCount} 个`, key: 'bulk' });
        }
      }
    });
  };

  const checkServers = async (ids: string[]) => {
    if (!selectedHost) {
      message.warning('请先选择配置源');
      return;
    }
    if (ids.length === 0) {
      message.warning('没有可检测的 MCP');
      return;
    }

    try {
      if (checkRun.running) {
        message.warning('已有检测任务进行中');
        return;
      }

      const controller = new AbortController();
      setCheckRun({ running: true, total: ids.length, done: 0, controller });

      const startAt = Date.now();
      const outcome: Record<string, 'ok' | 'fail'> = {};

      setHealth(prev => {
        const next = { ...prev };
        for (const id of ids) next[id] = { status: 'checking', checkedAt: startAt };
        return next;
      });

      const queue = [...ids];
      const concurrency = 2;

      const beginRowProgress = (id: string, expectedMs: number) => {
        if (progressTimersRef.current.has(id)) return;
        setRowProgress(prev => ({ ...prev, [id]: 5 }));
        const tickMs = 200;
        const step = Math.max(1, Math.ceil((90 * tickMs) / Math.max(1000, expectedMs)));
        const t = window.setInterval(() => {
          setRowProgress(prev => {
            const current = prev[id] ?? 5;
            if (current >= 95) return prev;
            return { ...prev, [id]: Math.min(95, current + step) };
          });
        }, tickMs);
        progressTimersRef.current.set(id, t);
      };

      const endRowProgress = (id: string) => {
        const t = progressTimersRef.current.get(id);
        if (t) window.clearInterval(t);
        progressTimersRef.current.delete(id);
        setRowProgress(prev => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      };

      const worker = async () => {
        while (queue.length > 0) {
          if (controller.signal.aborted) return;
          const id = queue.shift();
          if (!id) return;

          const cmd = servers[id]?.command;
          const base = cmd ? (cmd.split('/').pop()?.toLowerCase() ?? '') : '';
          const timeoutMs = (base === 'uv' || base === 'uvx') ? 15000 : 6000;
          beginRowProgress(id, timeoutMs);

          try {
            const resp = await mcpApi.check([id], selectedHost, timeoutMs, controller.signal);
            const r = resp.data?.data?.results?.[id];
            setHealth(prev => {
              const next = { ...prev };
              if (r?.ok) next[id] = { status: 'ok', latencyMs: r.latencyMs, checkedAt: Date.now() };
              else next[id] = { status: 'fail', latencyMs: r?.latencyMs, error: r?.error || resp.data?.error || '不可用', checkedAt: Date.now() };
              return next;
            });
            outcome[id] = r?.ok ? 'ok' : 'fail';
          } catch (e: any) {
            if (controller.signal.aborted) return;
            const err = e?.response?.data?.error || e?.message || '检测失败';
            setHealth(prev => {
              const next = { ...prev };
              next[id] = { status: 'fail', error: String(err), checkedAt: Date.now() };
              return next;
            });
            outcome[id] = 'fail';
          } finally {
            endRowProgress(id);
            setCheckRun(prev => (prev.running ? { ...prev, done: Math.min(prev.total, prev.done + 1) } : prev));
          }
        }
      };

      await Promise.all(Array.from({ length: concurrency }, worker));

      for (const [, t] of progressTimersRef.current) window.clearInterval(t);
      progressTimersRef.current.clear();
      setRowProgress({});
      setCheckRun({ running: false, total: 0, done: 0, controller: null });

      if (!controller.signal.aborted) {
        const okCount = Object.values(outcome).filter(x => x === 'ok').length;
        const failCount = Object.values(outcome).filter(x => x === 'fail').length;
        if (failCount === 0) message.success(`检测完成：可用 ${okCount} 个`);
        else message.warning(`检测完成：可用 ${okCount} 个，不可用 ${failCount} 个`);
      }
    } catch (e: any) {
      setCheckRun({ running: false, total: 0, done: 0, controller: null });
      const err = e?.response?.data?.error || e?.message || '检测失败';
      message.error(err);
    }
  };

  const cancelCheck = () => {
    const controller = checkRun.controller;
    if (!controller) return;
    controller.abort();
    setCheckRun({ running: false, total: 0, done: 0, controller: null });
    for (const [, t] of progressTimersRef.current) window.clearInterval(t);
    progressTimersRef.current.clear();
    setRowProgress({});
    setHealth(prev => {
      const next = { ...prev };
      for (const [id, h] of Object.entries(next)) {
        if (h?.status === 'checking') next[id] = { status: 'unknown' };
      }
      return next;
    });
    message.info('已取消检测');
  };

  const selectedHostInfo = useMemo(
    () => hosts.find(h => h.id === selectedHost),
    [hosts, selectedHost]
  );

  const formatRelativeTime = (ts?: number) => {
    if (!ts) return '-';
    const diff = Math.max(0, nowTs - ts);
    if (diff < 60_000) return '刚刚';
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} 天前`;
    return new Date(ts).toLocaleDateString();
  };

  const markUsed = (id: string) => {
    const ts = Date.now();
    setLastUsedAt(prev => {
      const next = { ...prev, [id]: ts };
      try {
        localStorage.setItem(lastUsedStorageKey, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const openDetails = (id: string, cfg: MCPServer) => {
    const isClaudeProject = selectedHostInfo?.id.startsWith('claude-code-project-');
    const origin = serverMeta?.[id]?.origin;
    const summaryHostId = (isClaudeProject && origin === 'global') ? 'claude-code' : (selectedHost || 'none');
    setDetails({ id, config: cfg, summaryHostId });
    markUsed(id);
  };

  const detailsCapabilitiesKey = useMemo(() => {
    if (!details) return '';
    return `${details.summaryHostId}:${details.id}`;
  }, [details?.id, details?.summaryHostId]);

  const detailsCapabilities = detailsCapabilitiesKey ? capabilitiesByKey[detailsCapabilitiesKey] : undefined;
  const detailsCapabilitiesLoading = detailsCapabilitiesKey && capabilitiesLoadingKey === detailsCapabilitiesKey;

  const fetchDetailsCapabilities = async (opts?: { force?: boolean }) => {
    if (!details) return;
    const hostId = details.summaryHostId;
    if (!hostId || hostId === 'none') {
      message.warning('请先选择配置源');
      return;
    }
    const key = `${hostId}:${details.id}`;
    try {
      setCapabilitiesLoadingKey(key);
      const resp = await mcpApi.capabilities([details.id], hostId, 10_000, { force: !!opts?.force });
      if (!resp.data?.success) {
        message.error(resp.data?.error || '获取能力失败');
        return;
      }

      const result = resp.data?.data?.results?.[details.id] as McpCapabilitiesResult | undefined;
      const cacheMetaRaw = resp.data?.data?.cache?.[details.id] as any;
      const cacheMeta: McpCapabilitiesCacheMeta | null =
        cacheMetaRaw && typeof cacheMetaRaw === 'object'
          ? {
            cachedAt: Number(cacheMetaRaw.cachedAt ?? 0),
            ttlMs: Number(cacheMetaRaw.ttlMs ?? 0),
            hit: !!cacheMetaRaw.hit
          }
          : null;
      if (!result) {
        message.error('未返回能力数据');
        return;
      }

      setCapabilitiesByKey(prev => ({ ...prev, [key]: result }));
      if (!result.ok) message.warning(`获取失败：${result.error}`);

      if (result.ok) {
        const existing = readCapabilitiesCacheFromStorage(hostId);
        const cachedAt = cacheMeta && Number.isFinite(cacheMeta.cachedAt) && cacheMeta.cachedAt > 0 ? cacheMeta.cachedAt : Date.now();
        const ttlMs = cacheMeta && Number.isFinite(cacheMeta.ttlMs) && cacheMeta.ttlMs > 0 ? cacheMeta.ttlMs : capabilitiesCacheOkTtlMs;
        existing[details.id] = { cachedAt, ttlMs, result: storableCapabilitiesResult(result) };
        saveCapabilitiesCacheToStorage(hostId, existing);

        setCapabilitiesCacheMetaByKey(prev => ({
          ...prev,
          [key]: { cachedAt, ttlMs, hit: cacheMeta?.hit }
        }));
      }
    } catch (e: any) {
      message.error(e?.response?.data?.error || '获取能力失败');
    } finally {
      setCapabilitiesLoadingKey(prev => (prev === key ? '' : prev));
    }
  };

  const formatDateTime = (ts: number) => {
    const d = new Date(ts);
    const pad2 = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  };

  const generateAiSummaryForDetails = async () => {
    if (!details) return;
    const hostId = details.summaryHostId;
    if (!hostId || hostId === 'none') {
      message.warning('请先选择配置源');
      return;
    }

    try {
      setAiSummaryLoading(true);
      const resp = await mcpApi.aiSummary(details.id, hostId, 60_000);
      if (!resp.data?.success) {
        message.error(resp.data?.error || '生成 AI 简介失败');
        return;
      }
      const summary = String(resp.data?.data?.summary ?? '').trim();
      if (!summary) {
        message.error('AI 简介为空');
        return;
      }

      const current = summaryDraft.trim();
      Modal.confirm({
        title: '简介预览',
        icon: <RobotOutlined />,
        width: 720,
        okText: current ? '覆盖简介' : '填入简介',
        cancelText: '取消',
        content: (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Input.TextArea
              readOnly
              value={summary}
              autoSize={{ minRows: 3, maxRows: 6 }}
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}
            />
          </Space>
        ),
        onOk: () => {
          setSummaryDraft(summary);
        }
      });
    } catch (e: any) {
      message.error(e?.response?.data?.error || e?.message || '生成 AI 简介失败');
    } finally {
      setAiSummaryLoading(false);
    }
  };

  const flash = (key: string) => {
    setFlashTarget(key);
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashTarget(''), 900);
  };

  const scrollToEl = (el: HTMLElement | null | undefined, flashKey?: string) => {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (flashKey) flash(flashKey);
  };

  const scrollToConfig = () => {
    setOutlineOpen(false);
    scrollToEl(configCardRef.current ?? null, 'config');
  };

  const scrollToMcpList = () => {
    setOutlineOpen(false);
    scrollToEl(mcpListCardRef.current ?? null, 'mcpList');
  };

  const scrollToMcp = (id: string) => {
    setOutlineOpen(false);
    const el = mcpCardRefs.current.get(id) ?? null;
    scrollToEl(el, `mcp:${id}`);
  };

  const urlTransportType = (cfg: MCPServer): 'sse' | 'http' => {
    const rawType = typeof cfg.type === 'string' ? cfg.type.toLowerCase() : '';
    if (rawType === 'sse') return 'sse';
    if (rawType === 'http' || rawType === 'streamable-http' || rawType === 'streamablehttp') return 'http';
    const u = String(cfg.url ?? '').toLowerCase();
    if (u.includes('/sse') || u.endsWith('/sse') || u.includes('sse')) return 'sse';
    return 'http';
  };

  const canViewScript = (cfg: MCPServer) => {
    if (!cfg || cfg.url) return false;
    const cmd = String(cfg.command ?? '').trim();
    if (!cmd) return false;
    const base = cmd.split('/').pop()?.toLowerCase() ?? cmd.toLowerCase();
    const runners = new Set(['uv', 'uvx', 'python', 'python3', 'py', 'node', 'bun']);
    if (!runners.has(base)) return false;
    const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
    return args.some(a => /\.(py|js|ts|mjs|cjs|tsx|jsx)$/i.test(a));
  };

  // Cleanup timers
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    };
  }, []);

  const viewScript = async (id: string) => {
    if (!selectedHost) return;
    try {
      setScriptView({ id, scriptPath: '', language: 'text', content: '' });
      setScriptLoading(true);
      const resp = await mcpApi.getScript(id, selectedHost);
      const data = resp.data?.data;
      setScriptView({
        id,
        scriptPath: String(data?.scriptPath ?? ''),
        language: String(data?.language ?? 'text'),
        content: String(data?.content ?? '')
      });
    } catch (e: any) {
      setScriptView(null);
      const err = e?.response?.data?.error || e?.message || '读取脚本失败';
      message.error(String(err));
    } finally {
      setScriptLoading(false);
    }
  };

  const viewSelectedHostConfigFile = async () => {
    if (!selectedHostInfo?.id) {
      message.warning('请先选择配置源');
      return;
    }

    try {
      setHostConfigFileView({ hostId: selectedHostInfo.id, path: selectedHostInfo.configPath, language: 'text', content: '' });
      setHostConfigFileLoading(true);
      const resp = await mcpApi.hostConfigFile(selectedHostInfo.id);
      const data = resp.data?.data;
      setHostConfigFileView({
        hostId: selectedHostInfo.id,
        path: String(data?.path ?? selectedHostInfo.configPath),
        language: String(data?.language ?? 'text'),
        content: String(data?.content ?? '')
      });
    } catch (e: any) {
      setHostConfigFileView(null);
      const err = e?.response?.data?.error || e?.message || '读取配置文件失败';
      message.error(String(err));
    } finally {
      setHostConfigFileLoading(false);
    }
  };

  const openSelectedHostProjectFolder = async () => {
    if (!selectedHostInfo?.id) {
      message.warning('请先选择配置源');
      return;
    }
    if (selectedHostInfo.scope !== 'project' || !selectedHostInfo.projectPath) {
      message.warning('当前配置源不是项目级，无法打开文件夹');
      return;
    }

    try {
      await mcpApi.openProjectFolder(selectedHostInfo.id);
    } catch (e: any) {
      const err = e?.response?.data?.error || e?.message || '打开文件夹失败';
      message.error(String(err));
    }
  };

  const inferSummary = (id: string, cfg: MCPServer): string => {
    try {
      if (cfg.url) {
        const t = urlTransportType(cfg);
        try {
          const u = new URL(cfg.url);
          const host = u.host || cfg.url;
          const path = (u.pathname && u.pathname !== '/') ? u.pathname : '';
          return `远程 MCP（${t.toUpperCase()}）：${host}${path}`;
        } catch {
          const safe = cfg.url.split('?')[0];
          return `远程 MCP（${t.toUpperCase()}）：${safe}`;
        }
      }

      const cmd = String(cfg.command ?? '').trim();
      const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
      const joined = [cmd, ...args].join(' ').toLowerCase();

      // Common: Playwright
      if (joined.includes('@playwright/mcp')) return 'Playwright MCP（浏览器自动化）';

      // Common: official servers
      const officialArg = args.find(a => /@modelcontextprotocol\/server-[a-z0-9-]+/i.test(a));
      if (officialArg) {
        const m = officialArg.match(/@modelcontextprotocol\/server-([a-z0-9-]+)/i);
        const name = m?.[1] ?? officialArg;
        return `官方 MCP Server：${name}`;
      }

      // Python local script via uv/uvx/python
      const base = cmd.split('/').pop()?.toLowerCase() ?? cmd.toLowerCase();
      const lastArg = args[args.length - 1] ?? '';
      const lastIsPy = typeof lastArg === 'string' && lastArg.toLowerCase().endsWith('.py');
      if ((base === 'uv' || base === 'uvx') && lastIsPy) {
        const file = lastArg.split('/').pop() ?? lastArg;
        return `本地脚本 MCP：${file}`;
      }
      if ((base === 'python' || base === 'python3' || base === 'py') && lastIsPy) {
        const file = lastArg.split('/').pop() ?? lastArg;
        return `本地脚本 MCP：${file}`;
      }

      // npx package
      if (base === 'npx') {
        const pkg = args.find(a => a && !a.startsWith('-'));
        if (pkg) return `npx MCP：${pkg}`;
      }

      if (cmd) return `stdio MCP：${cmd}`;
      return id;
    } catch {
      return '';
    }
  };

  const summaryFor = (hostId: string, id: string, cfg: MCPServer): SummaryEntry | null => {
    const manual = summariesByHost[hostId]?.[id];
    if (manual?.text) return manual;
    const inferred = inferSummary(id, cfg).trim();
    if (!inferred) return null;
    return { text: inferred, source: 'inferred', updatedAt: 0 };
  };

  const saveManualSummaryToHost = (hostId: string, id: string, text: string) => {
    const nextText = text.trim();
    setSummariesByHost(prev => {
      const hostMap = prev[hostId] ?? readSummariesFromStorage(hostId);
      const nextHostMap: SummariesMap = { ...hostMap };
      if (!nextText) delete nextHostMap[id];
      else nextHostMap[id] = { text: nextText, source: 'manual', updatedAt: Date.now() };
      const next = { ...prev, [hostId]: nextHostMap };
      try {
        localStorage.setItem(summariesStorageKeyFor(hostId), JSON.stringify(nextHostMap));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const inferToolId = (host: HostInfo): string => {
    if (host.id === 'claude-code' || host.id.startsWith('claude-code')) return 'claude-code';
    if (host.id === 'codex' || host.id.startsWith('codex')) return 'codex';
    if (host.id === 'cursor' || host.id.startsWith('cursor')) return 'cursor';
    if (host.id === 'vscode' || host.id.startsWith('vscode')) return 'vscode';
    if (host.id === 'claude-desktop' || host.id.startsWith('claude-desktop')) return 'claude-desktop';
    if (host.id === 'copilot' || host.id.startsWith('copilot')) return 'copilot';
    return host.id;
  };

  const toolLabel = (toolId: string) => {
    if (toolId === 'claude-code') return 'Claude Code';
    if (toolId === 'codex') return 'Codex';
    if (toolId === 'cursor') return 'Cursor';
    if (toolId === 'vscode') return 'VS Code';
    if (toolId === 'claude-desktop') return 'Claude Desktop';
    if (toolId === 'copilot') return 'GitHub Copilot';
    return toolId;
  };

  const isCodexHost = selectedHostInfo?.id === 'codex';
  const isClaudeCodeHost =
    selectedHostInfo?.id === 'claude-code' ||
    selectedHostInfo?.id.startsWith('claude-code-project-') ||
    selectedHostInfo?.name.startsWith('Claude Code');
  const isClaudeCodeGlobalHost = selectedHostInfo?.id === 'claude-code';
  const isClaudeCodeProjectHost = selectedHostInfo?.id.startsWith('claude-code-project-') ?? false;

  useEffect(() => {
    if (!details) return;
    const entry = summaryFor(details.summaryHostId, details.id, details.config);
    skipNextSummaryAutosaveRef.current = true;
    setSummaryDraft(entry?.text ?? '');
  }, [details?.id, details?.summaryHostId]);

  useEffect(() => {
    if (isClaudeCodeProjectHost) loadSummariesForHost('claude-code');
  }, [isClaudeCodeProjectHost, selectedHost]);

  useEffect(() => {
    if (isClaudeCodeProjectHost) loadCapabilitiesCacheForHost('claude-code');
  }, [isClaudeCodeProjectHost, selectedHost]);

  // Auto-save summary on change (debounced).
  useEffect(() => {
    if (!details) return;
    if (skipNextSummaryAutosaveRef.current) {
      skipNextSummaryAutosaveRef.current = false;
      return;
    }

    const id = details.id;
    const hostId = details.summaryHostId;
    const inferred = inferSummary(details.id, details.config).trim();
    const text = summaryDraft.trim();

    const t = window.setTimeout(() => {
      if (!text || (inferred && text === inferred)) {
        saveManualSummaryToHost(hostId, id, '');
        if (inferred && summaryDraft.trim() === '') {
          skipNextSummaryAutosaveRef.current = true;
          setSummaryDraft(inferred);
        }
        return;
      }

      saveManualSummaryToHost(hostId, id, text);
    }, 450);

    return () => window.clearTimeout(t);
  }, [summaryDraft, details]);

  const shellQuote = (value: string) => `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
  const shellToken = (value: string) => {
    const s = String(value);
    // Safe-ish shell token chars; quote everything else (spaces, quotes, &, ;, $, etc).
    if (/^[a-zA-Z0-9_@%+=:,./-]+$/.test(s)) return s;
    return shellQuote(s);
  };

  const buildInstallCliCommand = (id: string, config: MCPServer, hostInfo: HostInfo | undefined) => {
    if (isCodexHost) {
      if (config.url) {
        const bearer = config.headers?.['x-codex-bearer-token-env-var'];
        const parts = ['codex', 'mcp', 'add', shellToken(id), '--url', shellToken(config.url)];
        if (bearer) parts.push('--bearer-token-env-var', shellToken(bearer));
        return parts.join(' ');
      }

      if (!config.command) return null;

      const parts: string[] = ['codex', 'mcp', 'add', shellToken(id)];
      if (config.env) {
        for (const [k, v] of Object.entries(config.env)) {
          parts.push('--env', shellToken(`${k}=${v}`));
        }
      }
      parts.push('--', shellToken(config.command));
      for (const arg of (config.args ?? [])) parts.push(shellToken(arg));
      return parts.join(' ');
    }

    if (isClaudeCodeHost) {
      const scope = hostInfo?.scope === 'project' ? 'project' : 'user';
      const projectPath = hostInfo?.scope === 'project' ? hostInfo.projectPath : undefined;

      if (config.url) {
        const base = `claude mcp add ${shellToken(id)} -s ${scope} --url ${shellToken(config.url)}`;
        if (projectPath) return `cd ${shellQuote(projectPath)} && ${base}`;
        return base;
      }

      if (!config.command) return null;

      const parts: string[] = ['claude', 'mcp', 'add', shellToken(id), '-s', scope, '--'];
      if (config.env && Object.keys(config.env).length > 0) {
        parts.push('env');
        for (const [k, v] of Object.entries(config.env)) {
          parts.push(shellToken(`${k}=${v}`));
        }
      }
      parts.push(shellToken(config.command));
      for (const arg of (config.args ?? [])) parts.push(shellToken(arg));

      const cmd = parts.join(' ');
      if (projectPath) return `cd ${shellQuote(projectPath)} && ${cmd}`;
      return cmd;
    }

    return null;
  };

  const toolStats = useMemo(() => {
    const grouped = new Map<string, { toolId: string; userCount: number; projectCount: number; detectedUserCount: number; active: boolean }>();
    for (const host of hosts) {
      const toolId = inferToolId(host);
      const entry = grouped.get(toolId) ?? { toolId, userCount: 0, projectCount: 0, detectedUserCount: 0, active: false };
      if (host.scope === 'global') {
        entry.userCount += 1;
        if (host.detected) entry.detectedUserCount += 1;
      } else {
        entry.projectCount += 1;
      }
      if (host.active) entry.active = true;
      grouped.set(toolId, entry);
    }
    return grouped;
  }, [hosts]);

  const toolOptions = useMemo(() => {
    const TOOL_ORDER = ['claude-code', 'codex', 'cursor', 'vscode', 'claude-desktop', 'copilot'];
    const sorted = Array.from(toolStats.values()).sort((a, b) => {
      const ia = TOOL_ORDER.indexOf(a.toolId);
      const ib = TOOL_ORDER.indexOf(b.toolId);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      return a.toolId.localeCompare(b.toolId);
    });

    const filtered = onlyShowConfiguredTools
      ? sorted.filter(x => x.toolId === selectedTool || x.detectedUserCount > 0 || x.projectCount > 0)
      : sorted;

    return filtered.map(({ toolId, projectCount, detectedUserCount }) => ({
      value: toolId,
      label: (
        <Space size={8}>
          <span>{toolLabel(toolId)}</span>
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>用户 {detectedUserCount}</Tag>
          <Tag color="purple" style={{ marginInlineEnd: 0 }}>项目 {projectCount}</Tag>
        </Space>
      )
    }));
  }, [toolStats, onlyShowConfiguredTools, selectedTool]);

  const configSourceOptions = useMemo(() => {
    const relevant = hosts.filter(h => inferToolId(h) === selectedTool);
    const userHosts = relevant.filter(h => h.scope === 'global');
    const projectHosts = relevant.filter(h => h.scope === 'project');

    const isPinned = (hostId: string) => pinnedHostIds.has(hostId);
    const recentRank = (hostId: string) => {
      const idx = recentHostIds.indexOf(hostId);
      return idx === -1 ? 999 : idx;
    };

    const sortUser = (a: HostInfo, b: HostInfo) => {
      const ap = isPinned(a.id) ? 0 : 1;
      const bp = isPinned(b.id) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      const ad = a.detected ? 0 : 1;
      const bd = b.detected ? 0 : 1;
      if (ad !== bd) return ad - bd;
      const ar = recentRank(a.id);
      const br = recentRank(b.id);
      if (ar !== br) return ar - br;
      return a.name.localeCompare(b.name);
    };

    const sortProject = (a: HostInfo, b: HostInfo) => {
      const ap = isPinned(a.id) ? 0 : 1;
      const bp = isPinned(b.id) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      const ar = recentRank(a.id);
      const br = recentRank(b.id);
      if (ar !== br) return ar - br;
      const aKey = (a.projectPath ?? a.name).toLowerCase();
      const bKey = (b.projectPath ?? b.name).toLowerCase();
      return aKey.localeCompare(bKey);
    };

    const formatProjectDisplay = (projectPath?: string) => {
      if (!projectPath) return '';
      const parts = projectPath.split('/').filter(Boolean);
      if (parts.length === 0) return projectPath;
      const project = parts[parts.length - 1];
      const parent = parts.length >= 2 ? parts[parts.length - 2] : '';
      if (!parent) return project;
      return `${parent}/${project}`;
    };

    const highlightText = (text: string, query: string) => {
      const q = query.trim().toLowerCase();
      if (!q) return text;
      const lower = text.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx === -1) return text;
      const before = text.slice(0, idx);
      const mid = text.slice(idx, idx + q.length);
      const after = text.slice(idx + q.length);
      return (
        <>
          {before}
          <span className="hostProjectHighlight">{mid}</span>
          {after}
        </>
      );
    };

    const formatLabel = (host: HostInfo) => {
      if (host.scope === 'project') {
        const parts = (host.projectPath ?? '').split('/').filter(Boolean);
        const project = parts.length ? parts[parts.length - 1] : '';
        const parent = parts.length >= 2 ? parts[parts.length - 2] : '';
        const pinned = pinnedHostIds.has(host.id);
        return (
          <Space size={8}>
            <Tag color="purple" style={{ marginInlineEnd: 0 }}>项目</Tag>
            {pinned && <StarFilled style={{ color: '#faad14' }} />}
            <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4, minWidth: 0 }}>
              {parent ? (
                <>
                  <Text type="secondary">{highlightText(parent, configSourceSearch)}</Text>
                  <Text type="secondary">/</Text>
                </>
              ) : null}
              <Text strong>{highlightText(project || host.name, configSourceSearch)}</Text>
            </span>
          </Space>
        );
      }

      const pinned = pinnedHostIds.has(host.id);
      return (
        <Space size={8}>
          <Tag
            icon={host.detected ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
            color={host.detected ? 'blue' : 'default'}
            style={{ marginInlineEnd: 0 }}
          >
            用户
          </Tag>
          {pinned && <StarFilled style={{ color: '#faad14' }} />}
          <span>{host.name}</span>
        </Space>
      );
    };

    const toOption = (host: HostInfo) => ({
      value: host.id,
      label: formatLabel(host),
      disabled: host.scope === 'global' ? !host.detected : false,
      searchText: `${host.name} ${host.id} ${host.scope} ${host.projectPath ?? ''} ${formatProjectDisplay(host.projectPath)} ${host.configPath}`.toLowerCase()
    });

    const options: any[] = [];
    const sortedUser = [...userHosts].sort(sortUser);
    if (sortedUser.length > 0) options.push({ label: `用户级（${sortedUser.length}）`, options: sortedUser.map(toOption) });

    const sortedProject = [...projectHosts].sort(sortProject);
    if (sortedProject.length > 0) options.push({ label: `项目级（${sortedProject.length}）`, options: sortedProject.map(toOption) });

    return options;
  }, [hosts, selectedTool, pinnedHostIds, recentHostIds, configSourceSearch]);

  // Keep tool selection in sync when selectedHost changes (e.g. initial default host from backend).
  useEffect(() => {
    if (!selectedHostInfo) return;
    const tool = inferToolId(selectedHostInfo);
    if (tool && tool !== selectedTool) setSelectedTool(tool);
  }, [selectedHostInfo]);

  // When switching tool, auto-pick a reasonable config source under that tool.
  useEffect(() => {
    if (!hosts.length) return;
    const relevant = hosts.filter(h => inferToolId(h) === selectedTool);
    if (selectedHost && relevant.some(h => h.id === selectedHost)) return;
    const userHosts = relevant.filter(h => h.scope === 'global');
    const projectHosts = relevant.filter(h => h.scope === 'project');
    const preferred =
      userHosts.find(h => h.detected)?.id ??
      userHosts[0]?.id ??
      projectHosts[0]?.id ??
      '';
    if (preferred && preferred !== selectedHost) setSelectedHost(preferred);
  }, [hosts, selectedTool, selectedHost]);

  const serverEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    const entries = Object.entries(servers);
    const filteredByQuery = q ? entries.filter(([name]) => name.toLowerCase().includes(q)) : entries;
    const filteredByEnabled = filteredByQuery.filter(([, cfg]) => {
      if (enabledFilter === 'enabled') return !cfg.disabled;
      if (enabledFilter === 'disabled') return !!cfg.disabled;
      return true;
    });
    const filteredByType = filteredByEnabled.filter(([, cfg]) => {
      if (typeFilter === 'stdio') return !cfg.url;
      if (typeFilter === 'sse') return !!cfg.url && urlTransportType(cfg) === 'sse';
      if (typeFilter === 'http') return !!cfg.url && urlTransportType(cfg) === 'http';
      return true;
    });
    const filtered = (isClaudeCodeProjectHost && !showInherited && serverMeta)
      ? filteredByType.filter(([id]) => serverMeta?.[id]?.origin === 'project')
      : filteredByType;

    return filtered.sort(([aName, aCfg], [bName, bCfg]) => {
      const aDisabled = aCfg.disabled ? 1 : 0;
      const bDisabled = bCfg.disabled ? 1 : 0;
      if (aDisabled !== bDisabled) return aDisabled - bDisabled;
      return aName.localeCompare(bName);
    });
  }, [servers, query, enabledFilter, typeFilter, isClaudeCodeProjectHost, showInherited, serverMeta]);

  useEffect(() => {
    const visible = new Set(serverEntries.map(([id]) => id));
    setSelectedIds(prev => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const id of prev) {
        if (visible.has(id)) next.add(id);
      }
      return next;
    });
  }, [serverEntries]);

  const failedVisibleIds = useMemo(() => {
    const ids: string[] = [];
    for (const [id] of serverEntries) {
      if (health[id]?.status === 'fail') ids.push(id);
    }
    return ids;
  }, [serverEntries, health]);

  return (
    <ConfigProvider theme={{ algorithm: darkMode ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm }}>
    <Layout className="appLayout">
      <Header className="appHeader">
        <Space direction="vertical" size={0}>
          <Title level={3} className="appTitle" style={{ margin: 0 }}>MCP Manager</Title>
          <Text type="secondary">统一管理本地 MCP 配置源</Text>
        </Space>

        <Space>
          <Tooltip title={darkMode ? '切换到日间模式' : '切换到夜晚模式'}>
            <Button
              type="text"
              aria-label="toggle-dark-mode"
              shape="circle"
              className={`iconToggle ${darkMode ? 'iconToggleDark' : 'iconToggleLight'}`}
              icon={darkMode ? <SunFilled /> : <MoonFilled />}
              onClick={() => setDarkMode(v => !v)}
            />
          </Tooltip>
          <Tooltip title={showSecrets ? '当前：明文（点击切换脱敏）' : '当前：脱敏（点击切换明文）'}>
            <Button
              type="text"
              aria-label="toggle-secrets"
              shape="circle"
              className={`iconToggle ${showSecrets ? 'iconToggleSecretsRaw' : 'iconToggleSecretsRedacted'}`}
              icon={showSecrets ? <UnlockOutlined /> : <LockOutlined />}
              onClick={() => setShowSecretsSafely(!showSecrets)}
            />
          </Tooltip>
          <Button icon={<ReloadOutlined />} onClick={loadMCPData}>
            刷新
          </Button>
          <Button icon={<AppstoreOutlined />} onClick={() => setMarketOpen(true)}>
            插件市场
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd} disabled={!selectedHost}>
            添加 MCP
          </Button>
        </Space>
      </Header>

      <Content className="appContent">
        <div className="container">
          {loading ? (
            <Card className="card">
              <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
                <Spin size="large" tip="加载中..." />
              </div>
            </Card>
          ) : error ? (
            <Alert message="加载失败" description={error} type="error" showIcon />
          ) : (
            <>
              <div ref={configCardRef} className={flashTarget === 'config' ? 'flashTarget' : ''}>
              <Card
                className="card"
                title={(
                  <span className="cardTitle">
                    <SettingOutlined />
                    <span>{`配置源（${toolOptions.length}）`}</span>
                  </span>
                )}
                style={{ marginBottom: 16 }}
              >
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    {(() => {
                      const activeKey = (selectedTool === 'claude-code' || selectedTool === 'codex') ? selectedTool : 'other';

                      const claudeLabel = (
                        <Space size={6}>
                          <Text strong>Claude Code</Text>
                        </Space>
                      );
                      const codexLabel = (
                        <Space size={6}>
                          <Text strong>Codex</Text>
                        </Space>
                      );

                      const otherOptions = toolOptions.filter(x => x.value !== 'claude-code' && x.value !== 'codex');
                      const otherSelected = activeKey === 'other' ? selectedTool : (otherOptions[0]?.value ?? '');
                      const otherLabel = (
                        <Space size={6}>
                          <Text strong>其他</Text>
                          {activeKey === 'other' && otherSelected && <Tag style={{ marginInlineEnd: 0 }}>{toolLabel(otherSelected)}</Tag>}
                        </Space>
                      );

                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 320 }}>
                          <Tabs
                            size="small"
                            activeKey={activeKey}
                            onChange={(key) => {
                              if (key === 'claude-code' || key === 'codex') {
                                setSelectedTool(key);
                                return;
                              }
                              const preferred = otherOptions[0]?.value;
                              if (preferred) setSelectedTool(preferred);
                            }}
                            tabBarExtraContent={
                              <Tooltip title="全部：显示所有工具；有配置：仅显示有配置的工具">
                                <Segmented
                                  value={onlyShowConfiguredTools ? 'configured' : 'all'}
                                  onChange={(v) => setOnlyShowConfiguredTools(String(v) === 'configured')}
                                  options={[
                                    { label: '全部', value: 'all' },
                                    { label: '有配置', value: 'configured' }
                                  ]}
                                />
                              </Tooltip>
                            }
                            items={[
                              { key: 'claude-code', label: claudeLabel },
                              { key: 'codex', label: codexLabel },
                              { key: 'other', label: otherLabel }
                            ]}
                          />

                          {activeKey === 'other' && (
                            <Select
                              value={otherSelected || undefined}
                              placeholder="选择工具"
                              style={{ minWidth: 260, flex: 1 }}
                              options={otherOptions.map(o => ({ value: o.value, label: toolLabel(o.value) }))}
                              onChange={(value) => setSelectedTool(value)}
                            />
                          )}
                        </div>
                      );
                    })()}
                  </div>

                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Select
                      value={selectedHost || undefined}
                      placeholder="选择配置源（用户级 / 项目级）"
                      style={{ flex: 1 }}
                      options={configSourceOptions}
                      showSearch
                      onSearch={(v) => setConfigSourceSearch(v)}
                      onChange={(value) => {
                        setSelectedHost(value);
                        setConfigSourceSearch('');
                      }}
                      filterOption={(input, option) => String((option as any)?.searchText ?? '').includes(input.toLowerCase())}
                    />
                    <Tooltip title={selectedHost ? (pinnedHostIds.has(selectedHost) ? '取消置顶该配置源' : '置顶该配置源') : '请先选择配置源'}>
                      <Button
                        aria-label="pin-config-source"
                        icon={selectedHost && pinnedHostIds.has(selectedHost) ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
                        onClick={() => {
                          if (!selectedHost) return;
                          setPinnedHostIds(prev => {
                            const next = new Set(prev);
                            if (next.has(selectedHost)) next.delete(selectedHost);
                            else next.add(selectedHost);
                            return next;
                          });
                        }}
                        disabled={!selectedHost}
                      />
                    </Tooltip>
                  </div>

	                  <div className="hostMeta">
                      {selectedHostInfo?.scope === 'project' && selectedHostInfo?.projectPath ? (
                        <Tooltip title="点击打开项目文件夹">
                          <Text
                            type="secondary"
                            className="hostMetaItem hostMetaItemWrap hostMetaClickable"
                            role="button"
                            tabIndex={0}
                            onClick={openSelectedHostProjectFolder}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                openSelectedHostProjectFolder();
                              }
                            }}
                          >
                            <FolderOpenOutlined />
                            <span className="hostMetaText hostMetaTextWrap">
                              {toTildePath(selectedHostInfo.projectPath)}
                            </span>
                          </Text>
                        </Tooltip>
                      ) : (
                        <Text type="secondary" className="hostMetaItem hostMetaItemWrap">
                          <FolderOpenOutlined />
                          <span className="hostMetaText hostMetaTextWrap">
                            {selectedHostInfo?.name || '未选择'}
                          </span>
                        </Text>
                      )}

                      {selectedHostInfo?.configPath ? (
                        <Tooltip title="点击查看配置文件">
                          <Text
                            type="secondary"
                            className="hostMetaItem hostMetaItemWrap hostMetaClickable"
                            role="button"
                            tabIndex={0}
                            onClick={viewSelectedHostConfigFile}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                viewSelectedHostConfigFile();
                              }
                            }}
                            title={selectedHostInfo.configPath}
                          >
                            <SettingOutlined />
                            <span className="hostMetaText hostMetaTextWrap">{toTildePath(selectedHostInfo.configPath)}</span>
                          </Text>
                        </Tooltip>
                      ) : (
                        <Text type="secondary" className="hostMetaItem">
                          <SettingOutlined />
                          <span className="hostMetaText">-</span>
                        </Text>
                      )}
	                  </div>
                </Space>
              </Card>
              </div>

              <div ref={mcpListCardRef} className={flashTarget === 'mcpList' ? 'flashTarget' : ''}>
              <Card
                className="card"
                title={(
                  <span className="cardTitle">
                    <RobotOutlined />
                    <span>{`MCP (${serverEntries.length}${serverEntries.length !== Object.keys(servers).length ? ` / 总计 ${Object.keys(servers).length}` : ''})`}</span>
                  </span>
                )}
              >
                <div className="serverListHeader">
                  <Input.Search
                    allowClear
                    placeholder="搜索 MCP ID（按 / 聚焦）"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      style={{ maxWidth: 320 }}
                      ref={searchInputRef as any}
                    />
                  <Space wrap>
                    <Segmented
                      value={enabledFilter}
                      onChange={(v) => setEnabledFilter(v as any)}
                      options={[
                        { label: '全部', value: 'all' },
                        { label: '启用', value: 'enabled' },
                        { label: '禁用', value: 'disabled' }
                      ]}
                    />
                    <Segmented
                      value={typeFilter}
                      onChange={(v) => setTypeFilter(v as any)}
                      options={[
                        { label: '全部', value: 'all' },
                        { label: 'stdio', value: 'stdio' },
                        { label: 'SSE', value: 'sse' },
                        { label: 'HTTP', value: 'http' }
                      ]}
                    />
                    {!checkRun.running && failedVisibleIds.length > 0 && (
                      <Button size="small" icon={<RedoOutlined />} onClick={() => checkServers(failedVisibleIds)}>
                        重试失败项({failedVisibleIds.length})
                      </Button>
                    )}
                    {isClaudeCodeProjectHost && (
                      <Tooltip title="项目：仅显示项目级配置；全部：包含用户级继承">
                        <Segmented
                          value={showInherited ? 'all' : 'project'}
                          onChange={(v) => setShowInherited(String(v) === 'all')}
                          options={[
                            { label: '全部', value: 'all' },
                            { label: '项目', value: 'project' }
                          ]}
                        />
                      </Tooltip>
                    )}
                    <Tag color={selectedIds.size > 0 ? 'blue' : 'default'} style={{ marginInlineEnd: 0 }}>
                      已选 {selectedIds.size}
                    </Tag>
                    <Button icon={<CheckSquareOutlined />} onClick={selectAllFiltered} disabled={serverEntries.length === 0 || bulkLoading}>
                      全选
                    </Button>
                    <Button icon={<ClearOutlined />} onClick={clearSelection} disabled={selectedIds.size === 0 || bulkLoading}>
                      清空
                    </Button>
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: [
                          ...((isClaudeCodeGlobalHost)
                            ? []
                            : [
                              { key: 'enable', label: '批量启用', icon: <CheckCircleOutlined /> },
                              { key: 'disable', label: '批量禁用', icon: <CloseCircleOutlined /> }
                            ]),
                          { key: 'exportJson', label: '导出 JSON', icon: <ExportOutlined /> },
                          ...((isCodexHost || isClaudeCodeHost) ? [{ key: 'exportInstall', label: '导出安装命令', icon: <DownloadOutlined /> }] : []),
                          { key: 'check', label: '批量检测可用性', icon: <PlayCircleOutlined /> }
                        ] as any[],
                        onClick: ({ key }) => {
                          if (key === 'enable') bulkSetEnabled(true);
                          if (key === 'disable') bulkSetEnabled(false);
                          if (key === 'exportJson') exportSelectedAsJson();
                          if (key === 'exportInstall') exportSelectedAsInstallCommands();
                          if (key === 'check') checkServers(Array.from(selectedIds));
                        }
                      }}
                    >
                      <Button icon={<ExportOutlined />} loading={bulkLoading} disabled={selectedIds.size === 0}>
                        批量操作
                      </Button>
                    </Dropdown>
                  </Space>
                </div>

                {serverEntries.length === 0 ? (
                  <Empty description={Object.keys(servers).length === 0 ? '暂无 MCP' : '无匹配结果'} />
                ) : (
                  <List
                    dataSource={serverEntries}
                    renderItem={([name, config]) => {
                      const origin = serverMeta?.[name]?.origin;
                      const isClaudeProject = selectedHostInfo?.id.startsWith('claude-code-project-');
                      const inheritedGlobal = isClaudeProject && origin === 'global';
                      const summaryHostId = inheritedGlobal ? 'claude-code' : (selectedHost || 'none');

                      return (
                        <List.Item style={{ paddingInline: 0, width: '100%' }}>
                        <div
                          ref={(el) => {
                            if (el) mcpCardRefs.current.set(name, el);
                            else mcpCardRefs.current.delete(name);
                          }}
                          className={flashTarget === `mcp:${name}` ? 'flashTarget' : ''}
                          style={{ width: '100%' }}
                        >
                        <Card
                          className="mcpCard"
                          size="small"
                          style={{ width: '100%' }}
                          title={
                            <span className="mcpTitle">
                              <span className="mcpTitleLeft">
                                <Checkbox
                                  checked={selectedIds.has(name)}
                                  onChange={(e) => toggleSelected(name, e.target.checked)}
                                />
                                <Tooltip title="点击查看详情">
                                  <Text
                                    strong
                                    className={`mcpNameLink ${(!isClaudeCodeGlobalHost && config.disabled) ? 'mcpNameDisabled' : ''}`}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => openDetails(name, servers[name] ?? config)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        openDetails(name, servers[name] ?? config);
                                      }
                                    }}
                                  >
                                    {name}
                                  </Text>
                                </Tooltip>
                              {health[name]?.status === 'ok' && (
                                <Tooltip title={`可用 ${health[name]?.latencyMs ?? '-'}ms`}>
                                  <span className="statusDot statusDotOk" />
                                </Tooltip>
                              )}
                              {health[name]?.status === 'checking' && (
                                <Tooltip title={rowProgress[name] ? '检测中' : '排队中'}>
                                  <span className="statusDot statusDotChecking" />
                                </Tooltip>
                              )}
                              {health[name]?.status === 'fail' && (
                                <Tooltip title="不可用（点击查看错误详情）">
                                  <span
                                    className="statusDot statusDotFail"
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => {
                                      setExpandedErrorIds(prev => {
                                        const next = new Set(prev);
                                        if (next.has(name)) next.delete(name);
                                        else next.add(name);
                                        return next;
                                      });
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        setExpandedErrorIds(prev => {
                                          const next = new Set(prev);
                                          if (next.has(name)) next.delete(name);
                                          else next.add(name);
                                          return next;
                                        });
                                      }
                                    }}
                                  />
                                </Tooltip>
                              )}
                              {isClaudeProject && showInherited && origin && (
                                <Tag color={origin === 'project' ? 'purple' : 'blue'} style={{ marginInlineEnd: 0 }}>
                                  {origin === 'project' ? '项目' : '继承'}
                                </Tag>
                              )}
                              {config.url ? (
                                urlTransportType(config) === 'sse'
                                  ? <Tag color="purple" style={{ marginInlineEnd: 0 }}>SSE</Tag>
                                  : <Tag color="orange" style={{ marginInlineEnd: 0 }}>HTTP</Tag>
                              ) : (
                                <Tag color="green" style={{ marginInlineEnd: 0 }}>stdio</Tag>
                              )}
                              </span>
                              {health[name]?.status === 'checking' && checkRun.running && rowProgress[name] && (
                                <Space size={6}>
                                  <Progress
                                    size="small"
                                    percent={Math.max(5, Math.min(99, Math.floor(rowProgress[name])))}
                                    style={{ width: 160, marginBottom: 0 }}
                                    status="active"
                                    showInfo={false}
                                    strokeColor="#1677ff"
                                    trailColor="rgba(5, 5, 5, 0.06)"
                                  />
                                  <Tooltip title="取消本轮检测">
                                    <Button
                                      type="text"
                                      size="small"
                                      icon={<StopOutlined />}
                                      onClick={cancelCheck}
                                    />
                                  </Tooltip>
                                </Space>
                              )}
                              {health[name]?.status !== 'checking' && (health[name]?.checkedAt || lastUsedAt[name]) && (
                                <Space size={6}>
                                  {health[name]?.checkedAt && (
                                    <Tag icon={<ClockCircleOutlined />} style={{ marginInlineEnd: 0 }}>
                                      检测 {formatRelativeTime(health[name]?.checkedAt)}
                                    </Tag>
                                  )}
                                  {lastUsedAt[name] && (
                                    <Tag icon={<ClockCircleOutlined />} color="default" style={{ marginInlineEnd: 0 }}>
                                      使用 {formatRelativeTime(lastUsedAt[name])}
                                    </Tag>
                                  )}
                                </Space>
                              )}
                            </span>
                          }
                          extra={
                            <Space className="mcpRowActions" size={2}>
                              {!isClaudeCodeGlobalHost && (
                                <Switch
                                  size="small"
                                  checked={!config.disabled}
                                  onChange={() => handleToggle(name)}
                                  checkedChildren="启用"
                                  unCheckedChildren="禁用"
                                />
                              )}
                              <Tooltip title={featuredTemplateIds.has(name) ? '取消加精（从精选模板移除）' : '加精到精选模板'}>
                                <Button
                                  aria-label="feature"
                                  type="text"
                                  size="small"
                                  icon={featuredTemplateIds.has(name) ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
                                  onClick={() => {
                                    const baseCfg = servers[name] ?? config;
                                    if (featuredTemplateIds.has(name)) {
                                      unfeatureMcpFromMarketplace(name);
                                      return;
                                    }
                                    const entry = summaryFor(summaryHostId, name, baseCfg);
                                    featureMcpToMarketplace(name, baseCfg, entry?.text);
                                  }}
                                />
                              </Tooltip>
                              <Tooltip title="查看详情">
                                <Button
                                  aria-label="view-details"
                                  type="text"
                                  size="small"
                                  icon={<ProfileOutlined />}
                                  onClick={() => openDetails(name, servers[name] ?? config)}
                                />
                              </Tooltip>
                              <Tooltip title={inheritedGlobal ? '这是用户级配置（继承），请切换到 Claude Code（用户）编辑' : '编辑'}>
                                <Button
                                  aria-label="edit"
                                  type="text"
                                  size="small"
                                  icon={<EditOutlined />}
                                  disabled={inheritedGlobal}
                                  onClick={() => {
                                    markUsed(name);
                                    handleEdit(name, config);
                                  }}
                                />
                              </Tooltip>
                              <Tooltip title={inheritedGlobal ? '这是用户级配置（继承），请切换到 Claude Code（用户）删除' : '删除'}>
                                <Button
                                  aria-label="delete"
                                  type="text"
                                  size="small"
                                  danger
                                  icon={<DeleteOutlined />}
                                  disabled={inheritedGlobal}
                                  onClick={() => handleDelete(name)}
                                />
                              </Tooltip>
                              <Dropdown
                                trigger={['click']}
                                menu={{
                                  items: [
                                    ...(featuredTemplateIds.has(name)
                                      ? [{ key: 'unfeature', label: '取消加精（从精选模板移除）', icon: <StarFilled style={{ color: '#faad14' }} /> }]
                                      : [{ key: 'feature', label: '加精到精选模板', icon: <StarOutlined /> }]),
                                    { type: 'divider' as any },
                                    { key: 'check', label: '检测可用性', icon: <CheckCircleOutlined /> },
                                    ...(canViewScript(config) ? [{ key: 'viewScript', label: '查看脚本', icon: <FileTextOutlined /> }] : []),
                                    ...((isCodexHost || isClaudeCodeHost)
                                      ? [{ key: 'copyCli', label: '复制安装命令', icon: <CopyOutlined /> }]
                                      : [])
                                  ],
                                  onClick: async ({ key }) => {
                                    if (key === 'feature') {
                                      const baseCfg = servers[name] ?? config;
                                      const entry = summaryFor(summaryHostId, name, baseCfg);
                                      featureMcpToMarketplace(name, baseCfg, entry?.text);
                                      return;
                                    }
                                    if (key === 'unfeature') {
                                      unfeatureMcpFromMarketplace(name);
                                      return;
                                    }
                                    if (key === 'check') {
                                      await checkServers([name]);
                                      return;
                                    }
                                    if (key === 'viewScript') {
                                      await viewScript(name);
                                      return;
                                    }
                                    if (key === 'copyCli') {
                                      const baseCfg = servers[name] ?? config;
                                      const cfg = showSecrets ? baseCfg : redactConfig(baseCfg);

                                      // Claude Code 项目级：若该条目来自用户继承，用 user scope 生成更符合真实来源的命令
                                      if (isClaudeCodeProjectHost && isClaudeCodeHost) {
                                        const origin = serverMeta?.[name]?.origin;
                                        if (origin === 'global') {
                                          const hostInfoOverride: HostInfo | undefined = selectedHostInfo
                                            ? { ...selectedHostInfo, id: 'claude-code', name: 'Claude Code', scope: 'global', projectPath: undefined }
                                            : undefined;
                                          const cmd = buildInstallCliCommand(name, cfg, hostInfoOverride);
                                          if (!cmd) {
                                            message.error('无法生成安装命令');
                                            return;
                                          }
                                          await copyToClipboard(cmd);
                                          return;
                                        }
                                      }

                                      const cmd = buildInstallCliCommand(name, cfg, selectedHostInfo);
                                      if (!cmd) {
                                        message.error('无法生成安装命令');
                                        return;
                                      }
                                      await copyToClipboard(cmd);
                                    }
                                  }
                                }}
                              >
                                <Tooltip title="更多">
                                  <Button aria-label="more" type="text" size="small" icon={<MoreOutlined />} />
                                </Tooltip>
                              </Dropdown>
                            </Space>
                          }
                        >
                          <Space direction="vertical" size={6} style={{ width: '100%' }}>
                            {(() => {
                              const entry = summaryFor(summaryHostId, name, config);
                              if (!entry?.text) return null;
                              return (
                                <Tooltip title={entry.text}>
                                  <Text type="secondary" ellipsis style={{ maxWidth: '100%' }}>
                                    简介：{entry.text}
                                  </Text>
                                </Tooltip>
                              );
                            })()}
                            {config.command && (
                              <Text type="secondary">
                                命令：<Text code>{config.command}</Text>
                              </Text>
                            )}
                            {config.args && config.args.length > 0 && (
                              <Text type="secondary">
                                参数：<Text code>{config.args.join(' ')}</Text>
                              </Text>
                            )}
                            {config.url && (
                              <Text type="secondary">
                                URL：<Text code>{config.url}</Text>
                              </Text>
                            )}
                            {config.env && Object.keys(config.env).length > 0 && (
                              <div>
                                <Text type="secondary">环境变量：</Text>{' '}
                                {Object.keys(config.env).slice(0, 8).map(key => (
                                  <Tag key={key}>{key}</Tag>
                                ))}
                                {Object.keys(config.env).length > 8 && (
                                  <Tag>+{Object.keys(config.env).length - 8}</Tag>
                                )}
                              </div>
                            )}

                            {health[name]?.status === 'fail' && expandedErrorIds.has(name) && (
                              <Collapse
                                size="small"
                                ghost
                                items={[
                                  {
                                    key: 'err',
                                    label: '错误详情',
                                    children: (() => {
                                      const parsed = parseHealthError(health[name]?.error);
                                      const text = parsed.stderr
                                        ? `Error: ${parsed.error}\n\nStderr:\n${parsed.stderr}`
                                        : (parsed.error || '');
                                          return (
                                        <Space direction="vertical" size={8} style={{ width: '100%' }}>
                                          <Space>
                                            <Button size="small" icon={<CopyOutlined />} onClick={() => copyToClipboard(text)}>复制错误</Button>
                                            <Button
                                              size="small"
                                              icon={<UpOutlined />}
                                              onClick={() => setExpandedErrorIds(prev => {
                                                const next = new Set(prev);
                                                next.delete(name);
                                                return next;
                                              })}
                                            >
                                              收起
                                            </Button>
                                          </Space>
                                          <Input.TextArea
                                            readOnly
                                            value={text}
                                            autoSize={{ minRows: 4, maxRows: 12 }}
                                            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}
                                          />
                                        </Space>
                                      );
                                    })()
                                  }
                                ]}
                              />
                            )}
                          </Space>
                        </Card>
                        </div>
                      </List.Item>
                      );
                    }}
                  />
                )}
              </Card>
              </div>
            </>
          )}

		          <Drawer
              className="detailsDrawer"
		            title={
	              <Space size={8} style={{ minWidth: 0 }}>
	                <ProfileOutlined />
	                {details ? (
	                  <Text strong ellipsis={{ tooltip: details.id }} style={{ maxWidth: 640, fontSize: 18 }}>
	                    {details.id}
	                  </Text>
	                ) : (
	                  <span>详情</span>
	                )}
	              </Space>
	            }
	            open={!!details}
	            width={720}
		            onClose={() => setDetails(null)}
		          >
		            {details && (
		              <>
                  <Input.TextArea
                    value={summaryDraft}
                    onChange={(e) => setSummaryDraft(e.target.value)}
                    placeholder="为该 MCP 添加简介（仅本地保存，不会写回配置文件）"
                    autoSize={{ minRows: 3, maxRows: 6 }}
                    style={{ marginBottom: 8 }}
                  />
		
                  <Tabs
                    activeKey={detailsTab}
                    onChange={(k) => setDetailsTab(k as any)}
                    items={[
                      {
                        key: 'config',
                        label: '配置',
                        children: (
                          <>
	                            <div className="drawerToolbar" style={{ marginTop: 0 }}>
	                              <Space wrap size={6}>
                                  <Tooltip title="调用本地 codex CLI（非交互）基于 tools 列表生成一句话简介">
                                    <Button
                                      icon={<RobotOutlined />}
                                      loading={aiSummaryLoading}
                                      onClick={generateAiSummaryForDetails}
                                    >
                                      生成 AI 简介
                                    </Button>
                                  </Tooltip>
	                                <Tooltip title="默认脱敏（env/headers）。如需原始内容请先开启“显示敏感信息”。">
	                                  <Button
	                                    icon={<CopyOutlined />}
	                                    onClick={() => {
                                      const text = showSecrets ? toJson(details.config) : toJson(redactConfig(details.config));
                                      copyToClipboard(text);
                                    }}
                                  >
                                    复制 JSON
                                  </Button>
                                </Tooltip>
                                {isCodexHost && (
                                  <Tooltip title="默认脱敏（env/headers）。如需原始内容请使用“显示敏感信息”。">
                                    <Button
                                      icon={<CopyOutlined />}
                                      onClick={() => {
                                        const cfg = showSecrets ? details.config : redactConfig(details.config);
                                        const text = codexTomlForServer(details.id, cfg);
                                        copyToClipboard(text);
                                      }}
                                    >
                                      复制 TOML
                                    </Button>
                                  </Tooltip>
                                )}
                                {(isCodexHost || isClaudeCodeHost) && (
                                  <Button
                                    icon={<CopyOutlined />}
                                    onClick={async () => {
                                      const cfg = showSecrets ? details.config : redactConfig(details.config);
                                      const cmd = buildInstallCliCommand(details.id, cfg, selectedHostInfo);
                                      if (!cmd) {
                                        message.error('无法生成安装命令');
                                        return;
                                      }
                                      await copyToClipboard(cmd);
                                    }}
                                  >
                                    复制安装命令
                                  </Button>
                                )}
                              </Space>
                            </div>

                            <div style={{ border: '1px solid rgba(5, 5, 5, 0.12)', borderRadius: 8, overflow: 'hidden', height: '60vh' }}>
                              <Editor
                                language="json"
                                theme={darkMode ? 'vs-dark' : 'vs'}
                                value={showSecrets ? toJson(details.config) : toJson(redactConfig(details.config))}
                                options={{
                                  readOnly: true,
                                  minimap: { enabled: false },
                                  scrollBeyondLastLine: false,
                                  wordWrap: 'on',
                                  fontSize: 13,
                                  automaticLayout: true
                                }}
                              />
                            </div>
                          </>
                        )
                      },
                      {
                        key: 'capabilities',
                        label: '功能',
                        children: (
                          <Space direction="vertical" size={10} style={{ width: '100%' }}>
                            <Space wrap size={6}>
                              <Button
                                icon={<PlayCircleOutlined />}
                                onClick={() => fetchDetailsCapabilities()}
                                loading={!!detailsCapabilitiesLoading}
                                disabled={!selectedHost}
                              >
                                发现功能
                              </Button>
                              <Tooltip
                                title={(() => {
                                  const base = '忽略缓存，重新发现并刷新后端缓存';
                                  const meta = detailsCapabilitiesKey ? capabilitiesCacheMetaByKey[detailsCapabilitiesKey] : undefined;
                                  if (!meta || !Number.isFinite(meta.cachedAt) || !Number.isFinite(meta.ttlMs) || meta.cachedAt <= 0 || meta.ttlMs <= 0) {
                                    return base;
                                  }
                                  const expiresAt = meta.cachedAt + meta.ttlMs;
                                  return (
                                    <Space direction="vertical" size={2}>
                                      <div>{base}</div>
                                      <div>{`过期时间: ${formatDateTime(expiresAt)}`}</div>
                                    </Space>
                                  );
                                })()}
                              >
                                <Button
                                  icon={<ReloadOutlined />}
                                  onClick={() => fetchDetailsCapabilities({ force: true })}
                                  loading={!!detailsCapabilitiesLoading}
                                  disabled={!selectedHost}
                                >
                                  强制刷新
                                </Button>
                              </Tooltip>
                              <Button
                                icon={<CopyOutlined />}
                                disabled={!detailsCapabilities || !detailsCapabilities.ok}
                                onClick={() => {
                                  if (!detailsCapabilities || !detailsCapabilities.ok) return;
                                  copyToClipboard(toJson(detailsCapabilities.capabilities));
                                }}
                              >
                                复制结果
                              </Button>
                              {detailsCapabilities && (
                                <Tag color={detailsCapabilities.ok ? 'green' : 'red'} style={{ marginInlineEnd: 0 }}>
                                  {detailsCapabilities.ok ? `OK ${detailsCapabilities.latencyMs}ms` : `失败 ${detailsCapabilities.latencyMs}ms`}
                                </Tag>
                              )}
                              {detailsCapabilities?.ok && (
                                null
                              )}
                            </Space>

                            {!detailsCapabilities ? (
                              <Empty description="未获取。点击上方“发现功能”读取该 MCP 暴露的 tools/resources/prompts。" />
                            ) : !detailsCapabilities.ok ? (
                              <Alert message="获取能力失败" description={detailsCapabilities.error} type="error" showIcon />
                            ) : (
                              <Tabs
                                size="small"
                                items={[
                                  {
                                    key: 'tools',
                                    label: `Tools（${detailsCapabilities.capabilities.tools.length}${detailsCapabilities.supported.tools ? '' : ' / 不支持'}）`,
                                    children: detailsCapabilities.supported.tools ? (
                                      detailsCapabilities.capabilities.tools.length === 0 ? (
                                        <Empty description="tools 为空" />
                                      ) : (
                                        <Collapse
                                          size="small"
                                          className="capToolsCollapse"
                                          items={detailsCapabilities.capabilities.tools.map((t, idx) => ({
                                            key: `${idx}:${t.name}`,
                                            label: (
                                              <div className="capToolHeader">
                                                <Text strong className="capToolName">
                                                  {t.name}
                                                </Text>
                                                {t.description ? (
                                                  <Tooltip title={t.description}>
                                                    <Text type="secondary" className="capToolDesc">
                                                      {t.description}
                                                    </Text>
                                                  </Tooltip>
                                                ) : null}
                                              </div>
                                            ),
                                            children: (
                                              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                                                {t.description ? <Text type="secondary">{t.description}</Text> : null}
                                                <Text type="secondary">inputSchema</Text>
                                                <Input.TextArea
                                                  readOnly
                                                  value={t.inputSchema ? toJson(t.inputSchema) : '(no inputSchema)'}
                                                  autoSize={{ minRows: 6, maxRows: 16 }}
                                                  style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}
                                                />
                                              </Space>
                                            )
                                          }))}
                                        />
                                      )
                                    ) : (
                                      <Empty description="该 MCP 未实现 tools/list" />
                                    )
                                  },
                                  {
                                    key: 'resources',
                                    label: `Resources（${detailsCapabilities.capabilities.resources.length}${detailsCapabilities.supported.resources ? '' : ' / 不支持'}）`,
                                    children: detailsCapabilities.supported.resources ? (
                                      detailsCapabilities.capabilities.resources.length === 0 ? (
                                        <Empty description="resources 为空" />
                                      ) : (
                                        <Input.TextArea
                                          readOnly
                                          value={toJson(detailsCapabilities.capabilities.resources)}
                                          autoSize={{ minRows: 10, maxRows: 24 }}
                                          style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}
                                        />
                                      )
                                    ) : (
                                      <Empty description="该 MCP 未实现 resources/list" />
                                    )
                                  },
                                  {
                                    key: 'prompts',
                                    label: `Prompts（${detailsCapabilities.capabilities.prompts.length}${detailsCapabilities.supported.prompts ? '' : ' / 不支持'}）`,
                                    children: detailsCapabilities.supported.prompts ? (
                                      detailsCapabilities.capabilities.prompts.length === 0 ? (
                                        <Empty description="prompts 为空" />
                                      ) : (
                                        <Input.TextArea
                                          readOnly
                                          value={toJson(detailsCapabilities.capabilities.prompts)}
                                          autoSize={{ minRows: 10, maxRows: 24 }}
                                          style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}
                                        />
                                      )
                                    ) : (
                                      <Empty description="该 MCP 未实现 prompts/list" />
                                    )
                                  }
                                ]}
                              />
                            )}
                          </Space>
                        )
                      }
                    ]}
                  />
	              </>
	            )}
	          </Drawer>

          <Drawer
            title={bulkExport?.title ?? '批量导出'}
            open={!!bulkExport}
            width={820}
            onClose={() => setBulkExport(null)}
            extra={
              bulkExport ? (
                <Space>
                  <Button icon={<CopyOutlined />} onClick={() => copyToClipboard(showSecrets ? bulkExport.rawText : bulkExport.redactedText)}>
                    <Space size={6}>
                      <span>复制内容</span>
                      {showSecrets ? <UnlockOutlined /> : <LockOutlined />}
                    </Space>
                  </Button>
                  <Button type="primary" icon={<CloseOutlined />} onClick={() => setBulkExport(null)}>关闭</Button>
                </Space>
              ) : null
            }
          >
	            {bulkExport && (
	              <div style={{ border: '1px solid rgba(5, 5, 5, 0.12)', borderRadius: 8, overflow: 'hidden', height: '70vh' }}>
	                <Editor
	                  language={bulkExport.language || 'plaintext'}
	                  theme={darkMode ? 'vs-dark' : 'vs'}
	                  value={showSecrets ? bulkExport.rawText : bulkExport.redactedText}
	                  options={{
	                    readOnly: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    wordWrap: 'on',
                    fontSize: 13,
                    automaticLayout: true
                  }}
                />
              </div>
            )}
          </Drawer>

	          <Drawer
	            title={
	              scriptView
                ? (
                  <Space size={8} style={{ minWidth: 0 }}>
                    <FileTextOutlined />
                    <Text strong ellipsis={{ tooltip: scriptView.scriptPath || scriptView.id }} style={{ maxWidth: 640, fontSize: 18 }}>
                      {scriptView.scriptPath ? (scriptView.scriptPath.split('/').pop() ?? scriptView.scriptPath) : scriptView.id}
                    </Text>
                  </Space>
                )
                : (
                  <Space size={8}>
                    <FileTextOutlined />
                    <span>脚本</span>
                  </Space>
                )
            }
            className="scriptDrawer"
            open={!!scriptView}
            width={820}
            onClose={() => setScriptView(null)}
          >
	            {scriptView && (
	              <>
	                <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>
	                  路径：{scriptView.scriptPath || '-'}
	                </Text>
	                <div style={{ border: '1px solid rgba(5, 5, 5, 0.12)', borderRadius: 8, overflow: 'hidden', height: '70vh' }}>
	                  {scriptLoading ? (
	                    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 48 }}>
	                      <Spin tip="读取脚本中..." />
	                    </div>
	                  ) : (
	                    <Editor
	                      language={scriptView.language || 'text'}
	                      theme={darkMode ? 'vs-dark' : 'vs'}
	                      value={scriptView.content}
	                      options={{
	                        readOnly: true,
	                        minimap: { enabled: false },
	                        scrollBeyondLastLine: false,
	                        wordWrap: 'on',
	                        fontSize: 13,
	                        automaticLayout: true
	                      }}
	                    />
	                  )}
	                </div>
	              </>
	            )}
	          </Drawer>

            <Drawer
              title={
                hostConfigFileView
                  ? (
                    <Space size={8} style={{ minWidth: 0 }}>
                      <FileTextOutlined />
                      <Text strong ellipsis={{ tooltip: hostConfigFileView.path }} style={{ maxWidth: 640, fontSize: 18 }}>
                        {hostConfigFileView.path.split('/').pop() ?? hostConfigFileView.path}
                      </Text>
                    </Space>
                  )
                  : (
                    <Space size={8}>
                      <FileTextOutlined />
                      <span>配置文件</span>
                    </Space>
                  )
              }
              open={!!hostConfigFileView}
              width={820}
              onClose={() => setHostConfigFileView(null)}
            >
              {hostConfigFileView && (
                <>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>
                    路径：{hostConfigFileView.path || '-'}
                  </Text>
                  <div style={{ border: '1px solid rgba(5, 5, 5, 0.12)', borderRadius: 8, overflow: 'hidden', height: '70vh' }}>
                    {hostConfigFileLoading ? (
                      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 48 }}>
                        <Spin tip="读取配置文件中..." />
                      </div>
                    ) : (
                      <Editor
                        language={hostConfigFileView.language || 'text'}
                        theme={darkMode ? 'vs-dark' : 'vs'}
                        value={hostConfigFileView.content}
                        options={{
                          readOnly: true,
                          minimap: { enabled: false },
                          scrollBeyondLastLine: false,
                          wordWrap: 'on',
                          fontSize: 13,
                          automaticLayout: true
                        }}
                      />
                    )}
                  </div>
                </>
              )}
            </Drawer>

	          <MCPForm
	            visible={formVisible}
	            mode={formMode}
            initialValues={editingMCP}
            selectedHost={selectedHost}
            darkMode={darkMode}
            onClose={() => setFormVisible(false)}
            onSuccess={loadMCPData}
          />

	          <MarketplaceDrawer
	            open={marketOpen}
	            onClose={() => setMarketOpen(false)}
	            onImported={loadMCPData}
	            selectedHostId={selectedHost}
	            selectedHostName={selectedHostInfo?.name}
	            darkMode={darkMode}
              featuredTemplates={featuredTemplates.map(({ addedAt, ...t }) => t)}
	          />
        </div>
      </Content>

      <Popover
        trigger="click"
        open={outlineOpen}
        onOpenChange={(open) => setOutlineOpen(open)}
        placement="leftBottom"
        overlayClassName="outlinePopover"
        title={
          <div className="outlineTitle">
            <Space size={8}>
              <OrderedListOutlined />
              <span>目录</span>
            </Space>
            <Button type="text" size="small" icon={<CloseOutlined />} onClick={() => setOutlineOpen(false)} />
          </div>
        }
        content={
          <div className="outlinePanel">
            <div className="outlineControls">
              <Space.Compact block size="small">
                <Button icon={<AppstoreOutlined />} onClick={scrollToConfig}>配置源</Button>
                <Button icon={<OrderedListOutlined />} onClick={scrollToMcpList}>MCP</Button>
              </Space.Compact>

              <Input
                allowClear
                placeholder="搜索"
                value={outlineQuery}
                onChange={(e) => setOutlineQuery(e.target.value)}
                size="small"
                prefix={<SearchOutlined />}
              />
            </div>

            <div className="outlineList">
              {(() => {
                const q = outlineQuery.trim().toLowerCase();
                const items = serverEntries
                  .map(([id, cfg]) => ({ id, cfg }))
                  .filter(x => !q || x.id.toLowerCase().includes(q));

                if (items.length === 0) {
                  return <Empty description={serverEntries.length === 0 ? '暂无 MCP' : '无匹配结果'} />;
                }

                return (
                  <List
                    size="small"
                    split={false}
                    dataSource={items}
                    renderItem={({ id }) => {
                      return (
                        <List.Item
                          className="outlineItem"
                          onClick={() => scrollToMcp(id)}
                        >
                          <div className="outlineItemRow">
                            <Text className="outlineItemName" ellipsis>{id}</Text>
                            <Space size={6} className="outlineItemStatus">
                              {health[id]?.status === 'ok' && <span className="statusDot statusDotOk" />}
                              {health[id]?.status === 'checking' && <span className="statusDot statusDotChecking" />}
                              {health[id]?.status === 'fail' && <span className="statusDot statusDotFail" />}
                            </Space>
                          </div>
                        </List.Item>
                      );
                    }}
                  />
                );
              })()}
            </div>
          </div>
        }
      >
        <FloatButton
          icon={<OrderedListOutlined />}
          tooltip="目录"
	        />
	      </Popover>

      <Footer className="appFooter">
        <Space size={8} wrap>
          <Text type="secondary">MCP Manager</Text>
          <Text type="secondary">·</Text>
          <Typography.Link href="https://opensource.org/license/mit" target="_blank" rel="noreferrer">
            License (MIT)
          </Typography.Link>
          <Text type="secondary">·</Text>
          <Typography.Link href="https://github.com/18896101294" target="_blank" rel="noreferrer">
            Contact (GitHub)
          </Typography.Link>
        </Space>
      </Footer>
    </Layout>
    </ConfigProvider>
  );
}

export default App;
