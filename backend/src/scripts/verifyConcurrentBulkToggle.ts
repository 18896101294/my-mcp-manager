import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigService } from '../services/ConfigService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..', '..');

const makeMcpJson = (ids: string[]) => ({
  mcpServers: Object.fromEntries(
    ids.map(id => [
      id,
      {
        command: 'node',
        args: ['-e', 'console.log("ok")'],
        env: {}
      }
    ])
  )
});

const main = async () => {
  const tmpRoot = path.join(backendRoot, '.tmp', `verify-bulk-toggle-${Date.now()}`);
  const projectRoot = path.join(tmpRoot, 'demo-project');
  const cursorDir = path.join(projectRoot, '.cursor');
  const mcpPath = path.join(cursorDir, 'mcp.json');

  const ids = Array.from({ length: 20 }, (_, i) => `server-${i + 1}`);

  await fs.mkdir(cursorDir, { recursive: true });
  await fs.writeFile(mcpPath, JSON.stringify(makeMcpJson(ids), null, 2));

  // Limit scan to this temp project to speed up detection.
  process.env.MCP_PROJECT_SCAN_PATHS = projectRoot;
  process.env.MCP_PROJECT_SCAN_MAX_DEPTH = '1';
  process.env.MCP_PROJECT_SCAN_MAX_RESULTS = '20';

  const svc: any = new ConfigService();
  // Avoid polluting repo with backup files in verification runs.
  svc.backupConfig = async () => {};

  const hosts = await svc.getHosts();
  const host = hosts.find(
    (h: any) =>
      h.scope === 'project' &&
      h.projectPath === projectRoot &&
      h.id?.startsWith('cursor-project-')
  );

  if (!host) {
    throw new Error('Failed to detect temp Cursor project host');
  }

  await Promise.all(ids.map(id => svc.toggleMCP(host.id, id)));

  const config = await svc.readConfig(host.id);
  const failed = ids.filter(id => !config?.mcpServers?.[id] || config.mcpServers[id].disabled !== true);
  if (failed.length) {
    throw new Error(`Concurrent bulk toggle failed for ${failed.length} servers: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '...' : ''}`);
  }

  await fs.rm(tmpRoot, { recursive: true, force: true });
  console.log('OK: concurrent bulk toggle applied without lost updates');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

