// The MCP tool table itself: the eight v0.3 tools register, retired ones do
// not, and the `setOutputStyle` schema only admits the literal `Concise`.

import { describe, expect, it } from 'vitest';
import { Client, InMemoryTransport, McpServer, registerTools } from '../mcp/server/src/index.js';

async function connect() {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

describe('MCP tool table (v0.3)', () => {
  it('registers exactly the eight v0.3 tools', async () => {
    const { client, server } = await connect();
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'configureWorkspace',
        'nextChapter',
        'runPreflightProbe',
        'selectLesson',
        'setOutputStyle',
        'setPersonalization',
        'start',
        'verifyChapter',
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('setOutputStyle accepts only the literal Concise', async () => {
    const { client, server } = await connect();
    try {
      const tools = (await client.listTools()).tools;
      const schema = tools.find((t) => t.name === 'setOutputStyle')?.inputSchema as {
        properties?: Record<string, { const?: string; enum?: string[] }>;
      };
      const style = schema.properties?.['style'];
      expect(style?.const ?? style?.enum?.[0]).toBe('Concise');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
