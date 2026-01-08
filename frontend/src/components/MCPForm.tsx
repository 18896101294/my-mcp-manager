import { Modal, Form, Input, Select, Button, Space, Switch, Typography, message } from 'antd';
import { useState, useEffect } from 'react';
import { CodeOutlined, CloseOutlined, FormOutlined, FormatPainterOutlined, MinusCircleOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import Editor from '@monaco-editor/react';
import { parseMcpImportText } from '../utils/mcpImport';

const { Option } = Select;
const { Text } = Typography;

interface MCPFormProps {
  visible: boolean;
  mode: 'add' | 'edit';
  initialValues?: {
    id: string;
    config: any;
  };
  selectedHost: string;  // 当前选中的 host
  darkMode?: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const MCPForm: React.FC<MCPFormProps> = ({
  visible,
  mode,
  initialValues,
  selectedHost,
  darkMode,
  onClose,
  onSuccess
}) => {
  const [form] = Form.useForm();
  const [mcpType, setMcpType] = useState<'stdio' | 'sse' | 'http'>('stdio');
  const [loading, setLoading] = useState(false);
  const [inputMode, setInputMode] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState('');
  const [importId, setImportId] = useState('');
  const [upsert, setUpsert] = useState(true);

  const inferUrlType = (url?: string): 'sse' | 'http' => {
    const u = String(url ?? '').toLowerCase();
    if (u.includes('/sse') || u.endsWith('/sse') || u.includes('sse')) return 'sse';
    return 'http';
  };

  const toKeyValueList = (value: any): Array<{ key: string; value: string }> => {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const k = String((item as any).key ?? '');
          const v = String((item as any).value ?? '');
          if (!k || !v) return null;
          return { key: k, value: v };
        })
        .filter(Boolean) as Array<{ key: string; value: string }>;
    }
    if (typeof value === 'object') {
      return Object.entries(value).map(([k, v]) => ({ key: String(k), value: String(v ?? '') }));
    }
    return [];
  };

  useEffect(() => {
    if (visible && initialValues) {
      const inferred = initialValues.config?.url ? inferUrlType(initialValues.config?.url) : 'stdio';
      const rawType = typeof initialValues.config?.type === 'string' ? String(initialValues.config.type) : '';
      const lower = rawType.toLowerCase();
      const initialType: 'stdio' | 'sse' | 'http' =
        (lower === 'stdio' || lower === 'sse' || lower === 'http') ? (lower as any) : inferred;
      form.setFieldsValue({
        id: initialValues.id,
        type: initialType,
        ...initialValues.config,
        env: toKeyValueList(initialValues.config?.env),
        headers: toKeyValueList(initialValues.config?.headers)
      });
      setMcpType(initialType);
      setInputMode('form');
      setJsonText(JSON.stringify(initialValues.config ?? {}, null, 2));
      setImportId(initialValues.id);
    } else if (visible) {
      form.resetFields();
      setMcpType('stdio');
      setInputMode('form');
      setJsonText('');
      setImportId('');
    }
  }, [visible, initialValues, form]);

  const handleSubmit = async () => {
    try {
      setLoading(true);

      const isClaudeCodeHost = selectedHost === 'claude-code' || selectedHost.startsWith('claude-code-project-');
      const ensureClaudeType = (cfg: any) => {
        if (!isClaudeCodeHost) return cfg;
        if (cfg && typeof cfg === 'object' && !Array.isArray(cfg) && typeof cfg.type !== 'string') {
          if (cfg.url) cfg.type = inferUrlType(cfg.url);
          else if (cfg.command) cfg.type = 'stdio';
        }
        return cfg;
      };

      if (inputMode === 'form') {
        const values = await form.validateFields();

        const config: any = {};

        if (mcpType === 'stdio') {
          config.command = values.command;
          config.args = values.args || [];
          if (values.env && values.env.length > 0) {
            config.env = values.env.reduce((acc: any, item: any) => {
              if (item.key && item.value) {
                acc[item.key] = item.value;
              }
              return acc;
            }, {});
          }
        } else {
          config.url = values.url;
          if (values.headers && values.headers.length > 0) {
            config.headers = values.headers.reduce((acc: any, item: any) => {
              if (item.key && item.value) {
                acc[item.key] = item.value;
              }
              return acc;
            }, {});
          }
          // Persist transport type for URL-based MCP (http/sse), so checks and UI can distinguish.
          config.type = mcpType;
        }

        if (isClaudeCodeHost && mcpType === 'stdio') config.type = 'stdio';

        const apiCall = mode === 'add'
          ? () => import('../services/api').then(m => m.mcpApi.add(values.id, ensureClaudeType(config), selectedHost))
          : () => import('../services/api').then(m => m.mcpApi.update(values.id, ensureClaudeType(config), selectedHost));

        const response = await apiCall();
        if (response.data.success) {
          message.success(mode === 'add' ? '添加成功' : '更新成功');
          onSuccess();
          onClose();
        } else {
          message.error(response.data.error || '操作失败');
        }
        return;
      }

      const text = jsonText.trim();
      if (!text) {
        message.error('请输入要导入的 JSON');
        return;
      }

      const defaultIdFromContext = mode === 'edit' ? (initialValues?.id ?? '') : importId.trim();
      const parsed = parseMcpImportText(text, defaultIdFromContext || undefined);
      if (parsed.error) {
        message.error(parsed.error);
        return;
      }
      const items = parsed.items.map(item => ({ ...item, config: ensureClaudeType(item.config) }));

      const { mcpApi } = await import('../services/api');

      // edit 模式只更新当前这一条
      if (mode === 'edit') {
        const target = items[0];
        const resp = await mcpApi.update(target.id, target.config, selectedHost);
        if (resp.data.success) {
          message.success('更新成功');
          onSuccess();
          onClose();
        } else {
          message.error(resp.data.error || '操作失败');
        }
        return;
      }

      message.loading({ content: '导入中...', key: 'import', duration: 0 });
      let successCount = 0;
      const failed: Array<{ id: string; error: string }> = [];

      for (const item of items) {
        try {
          const resp = await mcpApi.add(item.id, item.config, selectedHost);
          if (resp.data.success) {
            successCount += 1;
            continue;
          }

          const errMsg = resp.data.error || '添加失败';
          if (upsert && /already exists/i.test(errMsg)) {
            const up = await mcpApi.update(item.id, item.config, selectedHost);
            if (up.data.success) {
              successCount += 1;
            } else {
              failed.push({ id: item.id, error: up.data.error || '更新失败' });
            }
          } else {
            failed.push({ id: item.id, error: errMsg });
          }
        } catch (e: any) {
          const err = e?.response?.data?.error || e?.message || '请求失败';
          if (upsert && /already exists/i.test(String(err))) {
            try {
              const up = await mcpApi.update(item.id, item.config, selectedHost);
              if (up.data.success) {
                successCount += 1;
              } else {
                failed.push({ id: item.id, error: up.data.error || '更新失败' });
              }
            } catch (e2: any) {
              failed.push({ id: item.id, error: e2?.response?.data?.error || e2?.message || '更新失败' });
            }
          } else {
            failed.push({ id: item.id, error: String(err) });
          }
        }
      }

      if (failed.length === 0) {
        message.success({ content: `导入完成：成功 ${successCount} 个`, key: 'import' });
        onSuccess();
        onClose();
        return;
      }

      message.warning({ content: `导入完成：成功 ${successCount} 个，失败 ${failed.length} 个`, key: 'import' });
      failed.slice(0, 3).forEach(f => message.error(`${f.id}: ${f.error}`));
      onSuccess();
    } catch (error: any) {
      console.error('Form submission error:', error);
      if (error.response?.data?.error) {
        message.error(error.response.data.error);
      } else {
        message.error('操作失败');
      }
    } finally {
      setLoading(false);
    }
  };

  const formatJson = () => {
    const text = jsonText.trim();
    if (!text) {
      message.warning('没有可格式化的内容');
      return;
    }
    try {
      const parsed = JSON.parse(text);
      setJsonText(JSON.stringify(parsed, null, 2));
      message.success('已格式化');
    } catch {
      message.error('JSON 格式不正确，无法格式化');
    }
  };

  return (
    <Modal
      title={mode === 'add' ? '添加 MCP' : '编辑 MCP'}
      open={visible}
      onCancel={onClose}
      footer={[
        <Button key="cancel" icon={<CloseOutlined />} onClick={onClose}>
          取消
        </Button>,
        <Button
          key="submit"
          type="primary"
          icon={mode === 'add' ? <PlusOutlined /> : <SaveOutlined />}
          loading={loading}
          onClick={handleSubmit}
        >
          {mode === 'add' ? '添加' : '更新'}
        </Button>
      ]}
      width={700}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space>
          <Button icon={<FormOutlined />} type={inputMode === 'form' ? 'primary' : 'default'} onClick={() => setInputMode('form')}>
            表单填写
          </Button>
          <Button icon={<CodeOutlined />} type={inputMode === 'json' ? 'primary' : 'default'} onClick={() => setInputMode('json')}>
            JSON 导入
          </Button>
        </Space>

        {inputMode === 'json' ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {mode === 'add' && (
              <Input
                value={importId}
                onChange={(e) => setImportId(e.target.value)}
                placeholder="默认 MCP ID（可选：当 JSON 是单条 config 时使用）"
              />
            )}
            <Space wrap align="center" size={12}>
              {mode === 'add' && (
                <Space align="center" size={8}>
                  <Switch checked={upsert} onChange={setUpsert} />
                  <Text type="secondary">已存在则更新</Text>
                </Space>
              )}
              <Button icon={<FormatPainterOutlined />} onClick={formatJson} disabled={!jsonText.trim()}>
                格式化 JSON
              </Button>
            </Space>
            <div style={{ border: '1px solid rgba(5, 5, 5, 0.12)', borderRadius: 8, overflow: 'hidden', height: 360 }}>
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
            {mode === 'edit' && (
              <Text type="secondary">编辑模式下将更新当前 MCP：{initialValues?.id}</Text>
            )}
          </Space>
        ) : (
          <Form
            form={form}
            layout="vertical"
            initialValues={{
              type: 'stdio',
              args: [],
              env: [],
              headers: []
            }}
          >
            <Form.Item
              label="MCP ID"
              name="id"
              rules={[{ required: true, message: '请输入 MCP ID' }]}
            >
              <Input placeholder="例如: my-mcp-server" disabled={mode === 'edit'} />
            </Form.Item>

            <Form.Item label="类型" name="type">
              <Select onChange={(value) => setMcpType(value)}>
                <Option value="stdio">stdio 模式</Option>
                <Option value="sse">SSE 模式</Option>
                <Option value="http">HTTP 模式</Option>
              </Select>
            </Form.Item>

            {mcpType === 'stdio' ? (
              <>
                <Form.Item
                  label="命令"
                  name="command"
                  rules={[{ required: true, message: '请输入命令' }]}
                >
                  <Input placeholder="例如: npx" />
                </Form.Item>

                <Form.Item label="参数">
                  <Form.List name="args">
                    {(fields, { add, remove }) => (
                      <>
                        {fields.map((field) => (
                          <Space key={field.key} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
                            <Form.Item
                              {...field}
                              noStyle
                            >
                              <Input placeholder="参数值" style={{ width: 400 }} />
                            </Form.Item>
                            <MinusCircleOutlined onClick={() => remove(field.name)} />
                          </Space>
                        ))}
                        <Button type="dashed" onClick={() => add()} icon={<PlusOutlined />}>
                          添加参数
                        </Button>
                      </>
                    )}
                  </Form.List>
                </Form.Item>

                <Form.Item label="环境变量">
                  <Form.List name="env">
                    {(fields, { add, remove }) => (
                      <>
                        {fields.map((field) => (
                          <Space key={field.key} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
                            <Form.Item
                              {...field}
                              name={[field.name, 'key']}
                              noStyle
                            >
                              <Input placeholder="变量名" style={{ width: 180 }} />
                            </Form.Item>
                            <Form.Item
                              {...field}
                              name={[field.name, 'value']}
                              noStyle
                            >
                              <Input placeholder="变量值" style={{ width: 180 }} />
                            </Form.Item>
                            <MinusCircleOutlined onClick={() => remove(field.name)} />
                          </Space>
                        ))}
                        <Button type="dashed" onClick={() => add()} icon={<PlusOutlined />}>
                          添加环境变量
                        </Button>
                      </>
                    )}
                  </Form.List>
                </Form.Item>
              </>
            ) : (
              <>
                <Form.Item
                  label="URL"
                  name="url"
                  rules={[{ required: true, message: '请输入 URL' }]}
                >
                  <Input placeholder="例如: https://..." />
                </Form.Item>

                <Form.Item label="Headers">
                  <Form.List name="headers">
                    {(fields, { add, remove }) => (
                      <>
                        {fields.map((field) => (
                      <Space key={field.key} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
                        <Form.Item
                          {...field}
                          name={[field.name, 'key']}
                          noStyle
                        >
                          <Input placeholder="Header 名称" style={{ width: 180 }} />
                        </Form.Item>
                        <Form.Item
                          {...field}
                          name={[field.name, 'value']}
                          noStyle
                        >
                          <Input placeholder="Header 值" style={{ width: 180 }} />
                        </Form.Item>
                        <MinusCircleOutlined onClick={() => remove(field.name)} />
                      </Space>
                    ))}
                    <Button type="dashed" onClick={() => add()} icon={<PlusOutlined />}>
                      添加 Header
                    </Button>
                  </>
                )}
              </Form.List>
            </Form.Item>
          </>
        )}
          </Form>
        )}
      </Space>
    </Modal>
  );
};
