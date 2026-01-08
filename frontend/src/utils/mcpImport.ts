export type McpImportItem = { id: string; config: any };

export const normalizeMcpImportPayload = (payload: any): McpImportItem[] => {
  if (!payload) return [];

  if (Array.isArray(payload)) {
    return payload.filter(Boolean).flatMap((item: any) => normalizeMcpImportPayload(item));
  }

  if (payload.mcpServers && typeof payload.mcpServers === 'object') {
    return Object.entries(payload.mcpServers).map(([id, config]) => ({ id: String(id), config }));
  }

  if (payload.id && payload.config) {
    return [{ id: String(payload.id), config: payload.config }];
  }

  return [{ id: '', config: payload }];
};

export const validateMcpServerConfig = (config: any): string | null => {
  if (!config || typeof config !== 'object') return '配置必须是对象';
  if (config.url) return null;
  if (config.command) return null;
  return '需要包含 command 或 url';
};

export const parseMcpImportText = (
  jsonText: string,
  defaultId?: string
): { items: McpImportItem[]; error?: string } => {
  const text = jsonText.trim();
  if (!text) return { items: [], error: '请输入 JSON' };

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { items: [], error: 'JSON 解析失败，请检查格式' };
  }

  const items = normalizeMcpImportPayload(parsed)
    .map(item => ({ id: item.id || (defaultId ?? ''), config: item.config }))
    .filter(item => item.id);

  if (items.length === 0) {
    return { items: [], error: '未识别到可导入的 MCP（需要 MCP ID 或使用 { "mcpServers": { ... } } 格式）' };
  }

  const invalid = items.find(i => validateMcpServerConfig(i.config));
  if (invalid) {
    return { items: [], error: `MCP "${invalid.id}" 配置不完整：${validateMcpServerConfig(invalid.config)}` };
  }

  return { items };
};

