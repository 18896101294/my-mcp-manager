import { AppstoreOutlined, ClearOutlined, CopyOutlined, ImportOutlined, LinkOutlined } from '@ant-design/icons';
import { Button, Card, Divider, Drawer, Input, List, Space, Switch, Tabs, Tag, Typography, message } from 'antd';
import { useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { McpImportItem } from '../utils/mcpImport';
import { parseMcpImportText } from '../utils/mcpImport';
import { mcpApi } from '../services/api';

const { Text, Link } = Typography;

type Marketplace = {
  id: string;
  name: string;
  url: string;
  description: string;
  tags?: string[];
};

type Template = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  json: any;
};

const marketplaces: Marketplace[] = [
  {
    id: 'smithery',
    name: 'Smithery',
    url: 'https://smithery.ai',
    description: '常见 MCP 服务器目录（可用 smithery cli 安装/运行）',
    tags: ['registry', 'cli']
  },
  {
    id: 'mcp-so',
    name: 'mcp.so',
    url: 'https://mcp.so',
    description: 'MCP 服务收录/索引站点',
    tags: ['directory']
  },
  {
    id: 'github-awesome',
    name: 'awesome-mcp-servers',
    url: 'https://github.com/punkpeye/awesome-mcp-servers',
    description: '社区整理的 MCP server 清单（GitHub）',
    tags: ['github']
  },
  {
    id: 'npm',
    name: 'npm',
    url: 'https://www.npmjs.com',
    description: '查找 npm 上的 MCP server 包（例如 @modelcontextprotocol/*）',
    tags: ['npm']
  }
];

const templates: Template[] = [
  {
    id: 'memory',
    name: 'Memory',
    description: '@modelcontextprotocol/server-memory（示例）',
    tags: ['stdio', 'official'],
    json: {
      mcpServers: {
        memory: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory']
        }
      }
    }
  },
  {
    id: 'filesystem',
    name: 'Filesystem (Smithery)',
    description: '通过 Smithery CLI 启动 filesystem（示例）',
    tags: ['stdio', 'smithery'],
    json: {
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: [
            '-y',
            '@smithery/cli@latest',
            'run',
            '@smithery-ai/filesystem',
            '--config',
            '{"allowedDirs":"/path/to/allowed"}'
          ]
        }
      }
    }
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    description: '@modelcontextprotocol/server-gitlab（示例，需 token/url）',
    tags: ['stdio', 'official'],
    json: {
      mcpServers: {
        gitlab: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-gitlab'],
          env: {
            GITLAB_PERSONAL_ACCESS_TOKEN: 'REPLACE_ME',
            GITLAB_API_URL: 'https://gitlab.example.com/api/v4'
          }
        }
      }
    }
  },
  {
    id: 'redis',
    name: 'Redis',
    description: '@modelcontextprotocol/server-redis（示例）',
    tags: ['stdio', 'official'],
    json: {
      mcpServers: {
        redis: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-redis', 'redis://:password@localhost:6379/0']
        }
      }
    }
  },
  {
    id: 'remote-sse',
    name: 'Remote (URL)',
    description: '远程 MCP（URL/HTTP，示例）',
    tags: ['url', 'remote'],
    json: {
      mcpServers: {
        remote: {
          url: 'https://example.com/mcp'
        }
      }
    }
  }
];

export type MarketplaceDrawerProps = {
  open: boolean;
  onClose: () => void;
  onImported?: () => void;
  selectedHostId?: string;
  selectedHostName?: string;
  darkMode?: boolean;
};

const copyToClipboard = async (text: string) => {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
};

export const MarketplaceDrawer: React.FC<MarketplaceDrawerProps> = ({
  open,
  onClose,
  onImported,
  selectedHostId,
  selectedHostName,
  darkMode
}) => {
  const [jsonText, setJsonText] = useState('');
  const [defaultId, setDefaultId] = useState('');
  const [upsert, setUpsert] = useState(true);
  const [importing, setImporting] = useState(false);

  const targetLabel = selectedHostName ? `${selectedHostName}（${selectedHostId}）` : (selectedHostId || '未选择');

  const parsed = useMemo(() => parseMcpImportText(jsonText, defaultId.trim() || undefined), [jsonText, defaultId]);

  const importItems = async (items: McpImportItem[]) => {
    if (!selectedHostId) {
      message.warning('请先在主界面选择配置源');
      return;
    }
    if (items.length === 0) {
      message.warning('没有可导入项');
      return;
    }

    setImporting(true);
    message.loading({ content: '导入中...', key: 'market-import', duration: 0 });

    let successCount = 0;
    const failed: Array<{ id: string; error: string }> = [];

    for (const item of items) {
      try {
        const resp = await mcpApi.add(item.id, item.config, selectedHostId);
        if (resp.data.success) {
          successCount += 1;
          continue;
        }
        const errMsg = resp.data.error || '添加失败';
        if (upsert && /already exists/i.test(errMsg)) {
          const up = await mcpApi.update(item.id, item.config, selectedHostId);
          if (up.data.success) successCount += 1;
          else failed.push({ id: item.id, error: up.data.error || '更新失败' });
        } else {
          failed.push({ id: item.id, error: errMsg });
        }
      } catch (e: any) {
        const err = e?.response?.data?.error || e?.message || '请求失败';
        if (upsert && /already exists/i.test(String(err))) {
          try {
            const up = await mcpApi.update(item.id, item.config, selectedHostId);
            if (up.data.success) successCount += 1;
            else failed.push({ id: item.id, error: up.data.error || '更新失败' });
          } catch (e2: any) {
            failed.push({ id: item.id, error: e2?.response?.data?.error || e2?.message || '更新失败' });
          }
        } else {
          failed.push({ id: item.id, error: String(err) });
        }
      }
    }

    setImporting(false);
    if (failed.length === 0) {
      message.success({ content: `导入完成：成功 ${successCount} 个`, key: 'market-import' });
      if (successCount > 0) onImported?.();
      return;
    }
    message.warning({ content: `导入完成：成功 ${successCount} 个，失败 ${failed.length} 个`, key: 'market-import' });
    if (successCount > 0) onImported?.();
    failed.slice(0, 3).forEach(f => message.error(`${f.id}: ${f.error}`));
  };

  return (
    <Drawer
      title={
        <Space>
          <AppstoreOutlined />
          插件市场 / 资源
        </Space>
      }
      open={open}
      width={820}
      onClose={onClose}
    >
      <Tabs
        items={[
          {
            key: 'templates',
            label: '精选模板',
            children: (
              <List
                grid={{ gutter: 12, xs: 1, sm: 1, md: 2, lg: 2, xl: 2, xxl: 2 }}
                dataSource={templates}
                renderItem={(t) => (
                  <List.Item>
                    <Card
                      size="small"
                      title={<Space>{t.name}{t.tags.map(tag => <Tag key={tag}>{tag}</Tag>)}</Space>}
                      actions={[
                        <Button
                          key="copy"
                          type="text"
                          icon={<CopyOutlined />}
                          onClick={async () => {
                            await copyToClipboard(JSON.stringify(t.json, null, 2));
                            message.success('已复制 JSON');
                          }}
                        >
                          复制 JSON
                        </Button>,
                        <Button
                          key="import"
                          type="text"
                          icon={<ImportOutlined />}
                          disabled={!selectedHostId || importing}
                          onClick={() => {
                            const text = JSON.stringify(t.json);
                            const { items, error } = parseMcpImportText(text);
                            if (error) {
                              message.error(error);
                              return;
                            }
                            void importItems(items);
                          }}
                        >
                          导入到当前源
                        </Button>
                      ]}
                    >
                      <Text type="secondary">{t.description}</Text>
                      <Divider style={{ marginBlock: 12 }} />
                      <Text type="secondary">目标配置源：</Text> <Text>{targetLabel}</Text>
                    </Card>
                  </List.Item>
                )}
              />
            )
          },
          {
            key: 'markets',
            label: '市场链接',
            children: (
              <List
                dataSource={marketplaces}
                renderItem={(m) => (
                  <List.Item>
                    <Space direction="vertical" style={{ width: '100%' }} size={4}>
                      <Space wrap>
                        <Link href={m.url} target="_blank" rel="noreferrer">
                          <Space>
                            <LinkOutlined />
                            {m.name}
                          </Space>
                        </Link>
                        {m.tags?.map(t => <Tag key={t}>{t}</Tag>)}
                      </Space>
                      <Text type="secondary">{m.description}</Text>
                    </Space>
                  </List.Item>
                )}
              />
            )
          },
          {
            key: 'json',
            label: 'JSON 导入',
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={12}>
                <Text type="secondary">
                  从插件市场复制 JSON 后粘贴到这里，然后导入到当前配置源：<Text strong>{targetLabel}</Text>
                </Text>

                <Space wrap align="center">
                  <Input
                    value={defaultId}
                    onChange={(e) => setDefaultId(e.target.value)}
                    placeholder="默认 MCP ID（可选：当 JSON 只有单条 config 时使用）"
                    style={{ width: 360 }}
                  />
                  <Space align="center" size={8}>
                    <Switch checked={upsert} onChange={setUpsert} />
                    <Text type="secondary">已存在则更新</Text>
                  </Space>
                </Space>

                <div style={{ border: '1px solid rgba(5, 5, 5, 0.12)', borderRadius: 8, overflow: 'hidden', height: 420 }}>
                  <Editor
                    language="json"
                    theme={darkMode ? 'vs-dark' : 'vs'}
                    value={jsonText}
                    onChange={(v) => setJsonText(v ?? '')}
                    options={{
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      wordWrap: 'on',
                      fontSize: 13,
                      automaticLayout: true
                    }}
                  />
                </div>

                {parsed.error ? (
                  <Text type="danger">{parsed.error}</Text>
                ) : (
                  <Text type="secondary">可导入：{parsed.items.length} 个</Text>
                )}

                <Space>
                  <Button
                    type="primary"
                    icon={<ImportOutlined />}
                    disabled={!selectedHostId || !!parsed.error || parsed.items.length === 0}
                    loading={importing}
                    onClick={() => void importItems(parsed.items)}
                  >
                    导入
                  </Button>
                  <Button
                    icon={<CopyOutlined />}
                    disabled={!jsonText.trim()}
                    onClick={async () => {
                      await copyToClipboard(jsonText);
                      message.success('已复制');
                    }}
                  >
                    复制文本
                  </Button>
                  <Button icon={<ClearOutlined />} onClick={() => setJsonText('')}>清空</Button>
                </Space>
              </Space>
            )
          }
        ]}
      />
    </Drawer>
  );
};
