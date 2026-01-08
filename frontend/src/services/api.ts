import axios from 'axios';

const API_BASE_URL = 'http://localhost:3000/api';

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json'
  }
});

// MCP 相关接口
export const mcpApi = {
  // 获取所有 MCP（支持可选的 hostId 参数）
  getAll: (hostId?: string) => api.get('/mcp', { params: hostId ? { hostId } : {} }),

  // 获取所有宿主
  getHosts: () => api.get('/mcp/hosts'),

  // 添加 MCP
  add: (id: string, config: any, hostId?: string) =>
    api.post('/mcp', { id, config, hostId }),

  // 更新 MCP
  update: (id: string, config: any, hostId?: string) =>
    api.put(`/mcp/${id}`, { config, hostId }),

  // 删除 MCP
  delete: (id: string, hostId?: string) =>
    api.delete(`/mcp/${id}`, { params: { hostId } }),

  // 切换启用/禁用
  toggle: (id: string, hostId?: string) =>
    api.patch(`/mcp/${id}/toggle`, {}, { params: { hostId } }),

  // 可用性检测（connect + ping）
  check: (ids?: string[], hostId?: string, timeoutMs?: number, signal?: AbortSignal) =>
    api.post('/mcp/check', { ids, hostId, timeoutMs }, signal ? { signal } : undefined),

  // 获取能力（tools/resources/prompts）
  capabilities: (ids?: string[], hostId?: string, timeoutMs?: number) =>
    api.post('/mcp/capabilities', { ids, hostId, timeoutMs }),

  // 生成 AI 简介
  aiSummary: (id: string, hostId?: string, timeoutMs?: number, model?: string, signal?: AbortSignal) => {
    const effectiveTimeoutMs = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : 60_000;
    // Axios instance default timeout is 10s; override for AI generation calls.
    const requestTimeoutMs = Math.max(30_000, Math.min(180_000, effectiveTimeoutMs + 15_000));
    return api.post('/mcp/ai-summary', { id, hostId, timeoutMs: effectiveTimeoutMs, model }, { timeout: requestTimeoutMs, signal });
  },

  // 查看本地脚本内容
  getScript: (id: string, hostId?: string) =>
    api.get('/mcp/script', { params: { id, hostId } })
};
