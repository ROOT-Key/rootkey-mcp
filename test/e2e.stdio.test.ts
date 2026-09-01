import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Exercises the shipped artifact the way a client does: spawn dist/index.js, speak MCP over stdio.
 * Run `npm run build` first.
 */
const BUNDLE = fileURLToPath(new URL('../dist/index.js', import.meta.url));

async function connect(env: Record<string, string>): Promise<{ client: Client; close: () => Promise<void> }> {
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE],
    env: { PATH: process.env.PATH ?? '', ROOTKEY_LOG_LEVEL: 'silent', ...env },
  });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

describe('stdio end to end', () => {
  beforeAll(() => {
    if (!existsSync(BUNDLE)) throw new Error(`Build first: ${BUNDLE} does not exist (npm run build).`);
  });

  it('completes the MCP handshake and advertises 27 tools', async () => {
    const { client, close } = await connect({ ROOTKEY_API_KEY: 'rk_test_e2e' });
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(27);
      expect(tools.map((tool) => tool.name)).toContain('rootkey_upload_file');

      // The instructions are how Claude learns the API's missing pieces.
      const instructions = client.getInstructions() ?? '';
      expect(instructions).toContain('NO endpoint that lists vaults');
      expect(instructions).toContain('one-time password');
    } finally {
      await close();
    }
  });

  it('serves 15 tools in read-only mode', async () => {
    const { client, close } = await connect({ ROOTKEY_API_KEY: 'rk_test_e2e', ROOTKEY_READ_ONLY: 'true' });
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(15);
      expect(tools.map((tool) => tool.name)).not.toContain('rootkey_delete_vault');
    } finally {
      await close();
    }
  });

  it('answers a network-free tool call', async () => {
    const { client, close } = await connect({
      ROOTKEY_API_KEY: 'rk_test_e2e',
      ROOTKEY_ENV: 'development',
    });
    try {
      const result = (await client.callTool({ name: 'rootkey_get_environment_info', arguments: {} })) as CallToolResult;
      const text = result.content.map((part) => ('text' in part ? part.text : '')).join('');
      const payload = JSON.parse(text) as Record<string, unknown>;

      expect(payload.environment).toBe('development');
      expect(payload.baseUrl).toBe('https://dev-api.rootkey.ai/api-v1/');
      expect(payload.keyMode).toBe('test');
      expect(payload.registeredTools).toBe(27);
    } finally {
      await close();
    }
  });

  it('exits non-zero with a clean stdout when the API key is missing', async () => {
    const child = spawn(process.execPath, [BUNDLE], {
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

    const exitCode = await new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)));

    expect(exitCode).toBe(1);
    expect(stderr).toContain('ROOTKEY_API_KEY');
    // Anything on stdout would corrupt the JSON-RPC stream.
    expect(stdout).toBe('');
  });
});
