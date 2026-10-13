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

  async function environmentInfo(env: Record<string, string>): Promise<Record<string, unknown>> {
    const { client, close } = await connect(env);
    try {
      const result = (await client.callTool({ name: 'rootkey_get_environment_info', arguments: {} })) as CallToolResult;
      const text = result.content.map((part) => ('text' in part ? part.text : '')).join('');
      return JSON.parse(text) as Record<string, unknown>;
    } finally {
      await close();
    }
  }

  it('answers a network-free tool call and reports the one public API by default', async () => {
    const payload = await environmentInfo({ ROOTKEY_API_KEY: 'rk_test_e2e' });

    expect(payload.environment).toBe('production');
    expect(payload.baseUrl).toBe('https://api.rootkey.ai/api-v1/');
    expect(payload.keyMode).toBe('test');
    expect(payload.registeredTools).toBe(27);
  });

  it('reports production for an explicit ROOTKEY_ENV=production', async () => {
    const payload = await environmentInfo({ ROOTKEY_API_KEY: 'rk_test_e2e', ROOTKEY_ENV: 'production' });

    expect(payload.environment).toBe('production');
    expect(payload.baseUrl).toBe('https://api.rootkey.ai/api-v1/');
  });

  it('reports custom for a self-hosted ROOTKEY_API_URL', async () => {
    const payload = await environmentInfo({
      ROOTKEY_API_KEY: 'rk_test_e2e',
      ROOTKEY_API_URL: 'https://onprem.example.test/api-v1',
    });

    expect(payload.environment).toBe('custom');
    expect(payload.baseUrl).toBe('https://onprem.example.test/api-v1/');
  });

  it('does not guess the key mode for an unprefixed UUID key', async () => {
    const payload = await environmentInfo({ ROOTKEY_API_KEY: '3f2b8c1e-9d4a-4e7b-8a61-5c0d2e7f9a10' });

    expect(payload.keyMode).toBe('unknown');
    expect(payload.environment).toBe('production');
  });

  it('declares only production and custom in the environment output schema', async () => {
    const { client, close } = await connect({ ROOTKEY_API_KEY: 'rk_test_e2e' });
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'rootkey_get_environment_info');
      const properties = (tool?.outputSchema?.properties ?? {}) as Record<string, { enum?: string[] }>;
      expect([...(properties.environment?.enum ?? [])].sort()).toEqual(['custom', 'production']);
    } finally {
      await close();
    }
  });

  it('reports the 0.1.1 version in the handshake and in the diagnostic tool', async () => {
    const { client, close } = await connect({ ROOTKEY_API_KEY: 'rk_test_e2e' });
    try {
      expect(client.getServerVersion()?.version).toBe('0.1.1');
      const result = (await client.callTool({ name: 'rootkey_get_environment_info', arguments: {} })) as CallToolResult;
      const text = result.content.map((part) => ('text' in part ? part.text : '')).join('');
      expect((JSON.parse(text) as Record<string, unknown>).serverVersion).toBe('0.1.1');
    } finally {
      await close();
    }
  });

  async function staleDevelopmentRun(extraEnv: Record<string, string>): Promise<{ stderr: string; payload: Record<string, unknown> }> {
    const client = new Client({ name: 'e2e', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BUNDLE],
      env: {
        PATH: process.env.PATH ?? '',
        ROOTKEY_API_KEY: 'rk_test_e2e',
        ROOTKEY_ENV: 'development',
        ROOTKEY_API_URL: 'https://onprem.example.test/api-v1',
        ...extraEnv,
      },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    try {
      // A single stray byte on stdout would break this handshake.
      await client.connect(transport);
      const result = (await client.callTool({ name: 'rootkey_get_environment_info', arguments: {} })) as CallToolResult;
      const text = result.content.map((part) => ('text' in part ? part.text : '')).join('');
      return { stderr, payload: JSON.parse(text) as Record<string, unknown> };
    } finally {
      await client.close();
      // The pipe may deliver its last chunk just after close.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it('starts with a stale ROOTKEY_ENV=development when ROOTKEY_API_URL is set: the URL wins, one warning on stderr', async () => {
    const run = await staleDevelopmentRun({});

    expect(run.payload.environment).toBe('custom');
    expect(run.payload.baseUrl).toBe('https://onprem.example.test/api-v1/');
    const warnings = run.stderr.split(/[\r\n]+/).filter((line) => /ROOTKEY_ENV/.test(line));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/obsolete/i);
    expect(warnings[0]).toMatch(/warn/i);
    expect(warnings[0]).not.toMatch(/dev-api/i);
  });

  it('prints no deprecation warning when ROOTKEY_LOG_LEVEL is silent', async () => {
    const run = await staleDevelopmentRun({ ROOTKEY_LOG_LEVEL: 'silent' });

    expect(run.payload.environment).toBe('custom');
    expect(run.stderr).not.toMatch(/ROOTKEY_ENV/);
  });

  it('prints no warning when ROOTKEY_ENV is production and ROOTKEY_API_URL is set', async () => {
    const run = await staleDevelopmentRun({ ROOTKEY_ENV: 'production' });

    expect(run.stderr).not.toMatch(/ROOTKEY_ENV|obsolete/);
  });

  it('refuses to start with ROOTKEY_ENV=development and explains the real alternatives on stderr', async () => {
    const child = spawn(process.execPath, [BUNDLE], {
      env: { PATH: process.env.PATH ?? '', ROOTKEY_API_KEY: 'rk_test_e2e', ROOTKEY_ENV: 'development' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

    const exitCode = await new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)));

    expect(exitCode).toBe(1);
    expect(stderr).toContain('configuration error');
    expect(stderr).toContain('ROOTKEY_ENV');
    expect(stderr).toContain('ROOTKEY_API_URL');
    expect(stderr).not.toMatch(/dev-api/i);
    expect(stdout).toBe('');
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
