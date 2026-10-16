import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
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

  it('completes the MCP handshake and advertises 29 tools to an organization API key', async () => {
    const { client, close } = await connect({ ROOTKEY_API_KEY: 'rk_test_e2e' });
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(29);
      expect(tools.map((tool) => tool.name)).toContain('rootkey_upload_file');
      expect(tools.map((tool) => tool.name)).not.toContain('rootkey_list_organizations');

      // The instructions are how Claude learns what the tool list cannot say.
      const instructions = client.getInstructions() ?? '';
      expect(instructions).not.toContain('NO endpoint that lists vaults');
      expect(instructions).toContain('rootkey_list_vaults');
      expect(instructions).toContain('one-time password');
    } finally {
      await close();
    }
  });

  it('serves 17 tools in read-only mode', async () => {
    const { client, close } = await connect({ ROOTKEY_API_KEY: 'rk_test_e2e', ROOTKEY_READ_ONLY: 'true' });
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(17);
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
    expect(payload.registeredTools).toBe(29);
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

  it('reports the 0.2.0 version in the handshake and in the diagnostic tool', async () => {
    const { client, close } = await connect({ ROOTKEY_API_KEY: 'rk_test_e2e' });
    try {
      expect(client.getServerVersion()?.version).toBe('0.2.0');
      const result = (await client.callTool({ name: 'rootkey_get_environment_info', arguments: {} })) as CallToolResult;
      const text = result.content.map((part) => ('text' in part ? part.text : '')).join('');
      expect((JSON.parse(text) as Record<string, unknown>).serverVersion).toBe('0.2.0');
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

/* ------------------------------------------------------------------ *
 * 0.2.0: a personal access token, over stdio, against a local stub of the API
 * ------------------------------------------------------------------ */

const PAT = `rk_pat_${'0123456789abcdef'.repeat(4)}`;
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

interface StubbedRequest {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
}

interface StubbedReply {
  status?: number;
  json: unknown;
}

/**
 * A real HTTP server on loopback, so the spawned bundle makes real requests (ROOTKEY_API_URL accepts plain http
 * for loopback only). The test then reads off the wire what the bundle sent, which no in-process stub can show.
 */
async function startStubApi(
  reply: (request: StubbedRequest) => StubbedReply,
): Promise<{ baseUrl: string; requests: StubbedRequest[]; close: () => Promise<void> }> {
  const requests: StubbedRequest[] = [];
  const server = createServer((req, res) => {
    const request: StubbedRequest = {
      method: req.method ?? 'GET',
      url: new URL(req.url ?? '/', 'http://stub.invalid'),
      headers: req.headers,
    };
    requests.push(request);
    const answer = reply(request);
    res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.json));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/api-v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const rawPage = (data: unknown[], nextCursor: string | null = null) => ({
  data,
  pagination: { previousCursor: null, nextCursor },
  metadata: {},
});

async function connectWithStderr(env: Record<string, string>): Promise<{
  client: Client;
  stderr: () => string;
  close: () => Promise<void>;
}> {
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE],
    env: { PATH: process.env.PATH ?? '', ROOTKEY_LOG_LEVEL: 'warn', ...env },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  await client.connect(transport);
  return {
    client,
    stderr: () => stderr,
    close: async () => {
      await client.close();
      // The pipe may deliver its last chunk just after close.
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  };
}

const textOfResult = (result: CallToolResult): string =>
  result.content.map((part) => ('text' in part ? part.text : '')).join('\n');

const payloadOfResult = (result: CallToolResult): unknown => {
  const texts = result.content.filter((part): part is { type: 'text'; text: string } => part.type === 'text');
  return JSON.parse(texts[texts.length - 1]!.text);
};

describe('stdio end to end with a personal access token', () => {
  beforeAll(() => {
    if (!existsSync(BUNDLE)) throw new Error(`Build first: ${BUNDLE} does not exist (npm run build).`);
  });

  it('advertises 23 tools, including the three new listings and none the API refuses to agents, and prints no deprecation warning', async () => {
    const { client, stderr, close } = await connectWithStderr({ ROOTKEY_TOKEN: PAT });
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toHaveLength(23);
      for (const name of ['rootkey_list_organizations', 'rootkey_list_vaults', 'rootkey_list_tables']) {
        expect(names).toContain(name);
      }
      expect(names.filter((name) => /recovery_point|audit_report/.test(name))).toEqual([]);
      expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).not.toContain('backup_workspace');
      const instructions = client.getInstructions() ?? '';
      expect(instructions).toContain('rootkey_list_organizations');
      expect(instructions).toMatch(/ASK the user which/);
      expect(stderr()).not.toMatch(/deprecated/);
    } finally {
      await close();
    }
  });

  it('lists organizations with the Bearer token, pages with the cursor, and shows mode and blocked', async () => {
    const api = await startStubApi((request) =>
      request.url.searchParams.get('cursor') === 'c-2'
        ? { json: rawPage([{ id: ORG_B, name: 'Globex', mode: 'FULL', blocked: true }]) }
        : { json: rawPage([{ id: ORG_A, name: 'Acme', mode: 'READ_ONLY', blocked: false }], 'c-2') },
    );
    const { client, close } = await connect({ ROOTKEY_TOKEN: PAT, ROOTKEY_API_URL: api.baseUrl, ROOTKEY_ORGANIZATION: ORG_A });
    try {
      const first = (await client.callTool({ name: 'rootkey_list_organizations', arguments: { limit: 1 } })) as CallToolResult;
      const firstPayload = payloadOfResult(first) as { items: Array<Record<string, unknown>>; pagination: { nextCursor: string } };
      expect(firstPayload.items[0]).toMatchObject({ id: ORG_A, mode: 'READ_ONLY', blocked: false });
      expect(firstPayload.pagination.nextCursor).toBe('c-2');

      const second = (await client.callTool({
        name: 'rootkey_list_organizations',
        arguments: { limit: 1, cursor: firstPayload.pagination.nextCursor },
      })) as CallToolResult;
      expect((payloadOfResult(second) as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({ id: ORG_B, blocked: true });
      // The page that holds a blocked organization says so in words.
      expect(textOfResult(second)).toMatch(/1 organization\(s\)/);

      expect(api.requests).toHaveLength(2);
      for (const request of api.requests) {
        expect(request.method).toBe('GET');
        expect(request.url.pathname).toBe('/api-v1/organizations');
        expect(request.headers.authorization).toBe(`Bearer ${PAT}`);
        expect(request.headers['x-api-key']).toBeUndefined();
        // Not an organization-scoped call, even with a default organization configured.
        expect(request.headers['x-rootkey-organization']).toBeUndefined();
      }
      expect(api.requests[1]!.url.searchParams.get('cursor')).toBe('c-2');
    } finally {
      await close();
      await api.close();
    }
  });

  it('lists vaults and tables in the selected organization and namespace, naming the rows an agent cannot open', async () => {
    const api = await startStubApi(() => ({
      json: rawPage([
        { address: '0xaaa', name: 'Contracts', dataClassification: 'INTERNAL', agentAccessible: true },
        { address: '0xbbb', name: 'Payroll', dataClassification: 'RESTRICTED', agentAccessible: false },
      ]),
    }));
    const { client, close } = await connect({
      ROOTKEY_TOKEN: PAT,
      ROOTKEY_API_URL: api.baseUrl,
      ROOTKEY_ORGANIZATION: ORG_A,
      ROOTKEY_TEST_MODE: 'true',
    });
    try {
      const vaults = (await client.callTool({ name: 'rootkey_list_vaults', arguments: {} })) as CallToolResult;
      // The per-call argument overrides the default for that call only.
      const tables = (await client.callTool({ name: 'rootkey_list_tables', arguments: { organization: ORG_B } })) as CallToolResult;

      expect((payloadOfResult(vaults) as { items: unknown[] }).items).toHaveLength(2);
      expect(textOfResult(vaults)).toContain('agentAccessible false');
      expect(tables.isError).toBeFalsy();

      expect(api.requests.map((r) => r.url.pathname)).toEqual(['/api-v1/vaults', '/api-v1/tables']);
      expect(api.requests.map((r) => r.headers['x-rootkey-organization'])).toEqual([ORG_A, ORG_B]);
      for (const request of api.requests) {
        expect(request.headers['x-test-mode']).toBe('true');
        expect(request.headers.authorization).toBe(`Bearer ${PAT}`);
      }
    } finally {
      await close();
      await api.close();
    }
  });

  it('asks which organization to use when none is selected, and sends nothing', async () => {
    const api = await startStubApi(() => ({ json: rawPage([]) }));
    const { client, close } = await connect({ ROOTKEY_TOKEN: PAT, ROOTKEY_API_URL: api.baseUrl });
    try {
      const result = (await client.callTool({ name: 'rootkey_list_vaults', arguments: {} })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(textOfResult(result)).toContain('rootkey_list_organizations');
      expect(textOfResult(result)).toMatch(/ask the user/i);
      expect(api.requests).toHaveLength(0);
    } finally {
      await close();
      await api.close();
    }
  });

  it('reports identity and the organization policy from /me and /organization, without the token', async () => {
    const api = await startStubApi((request) =>
      request.url.pathname.endsWith('/me')
        ? {
            json: {
              user: { id: 'u1', name: 'Luis', email: 'luis@example.test' },
              credential: { id: 'c1', type: 'PAT', name: 'laptop', scopes: ['rootkey.read'], allOrganizations: true, organizationIds: [], expiresAt: null },
            },
          }
        : { json: { id: ORG_A, name: 'Acme', mode: 'READ_ONLY', effectiveScopes: ['rootkey.read'] } },
    );
    const { client, close } = await connect({ ROOTKEY_TOKEN: PAT, ROOTKEY_API_URL: api.baseUrl, ROOTKEY_ORGANIZATION: ORG_A });
    try {
      const result = (await client.callTool({ name: 'rootkey_get_environment_info', arguments: {} })) as CallToolResult;
      const payload = payloadOfResult(result) as Record<string, unknown>;

      expect(payload.credentialType).toBe('personal_access_token');
      expect(payload.registeredTools).toBe(23);
      expect(payload.organization).toMatchObject({ mode: 'READ_ONLY', effectiveScopes: ['rootkey.read'] });
      expect(payload).not.toHaveProperty('keyMode');
      expect(textOfResult(result)).not.toContain(PAT);
      expect(api.requests.map((r) => r.url.pathname)).toEqual(['/api-v1/me', '/api-v1/organization']);
    } finally {
      await close();
      await api.close();
    }
  });

  it('turns a policy refusal into a tool error that says what to change, and keeps serving', async () => {
    const api = await startStubApi((request) =>
      request.url.pathname.endsWith('/vaults')
        ? {
            status: 403,
            json: { error: { requestId: 'req-1', message: 'Agent access is disabled in this organization.', errorCode: 'agent_access_disabled' } },
          }
        : { json: rawPage([]) },
    );
    const { client, close } = await connect({ ROOTKEY_TOKEN: PAT, ROOTKEY_API_URL: api.baseUrl, ROOTKEY_ORGANIZATION: ORG_A });
    try {
      const denied = (await client.callTool({ name: 'rootkey_list_vaults', arguments: {} })) as CallToolResult;
      expect(denied.isError).toBe(true);
      expect(textOfResult(denied)).toContain('agent_access_disabled');
      expect(textOfResult(denied)).toContain('Settings -> AI agents');
      expect(textOfResult(denied)).not.toContain(PAT);

      // The process is still up and the next call works.
      const next = (await client.callTool({ name: 'rootkey_list_tables', arguments: {} })) as CallToolResult;
      expect(next.isError).toBeFalsy();
    } finally {
      await close();
      await api.close();
    }
  });

  it('keeps an organization API key working: x-api-key only, one deprecation warning, no organization tool or argument', async () => {
    const api = await startStubApi(() => ({ json: rawPage([{ address: '0xaaa', name: 'Contracts' }]) }));
    const { client, stderr, close } = await connectWithStderr({ ROOTKEY_API_KEY: 'rk_test_e2e', ROOTKEY_API_URL: api.baseUrl });
    try {
      const listed = (await client.callTool({ name: 'rootkey_list_vaults', arguments: {} })) as CallToolResult;
      expect(listed.isError).toBeFalsy();
      expect(api.requests[0]!.headers['x-api-key']).toBe('rk_test_e2e');
      expect(api.requests[0]!.headers.authorization).toBeUndefined();
      expect(api.requests[0]!.headers['x-rootkey-organization']).toBeUndefined();

      const organizations = (await client.callTool({ name: 'rootkey_list_organizations', arguments: {} })) as CallToolResult;
      expect(organizations.isError).toBe(true);
      expect(api.requests).toHaveLength(1);
      expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('rootkey_list_organizations');
      for (const tool of (await client.listTools()).tools) {
        expect(tool.inputSchema.properties ?? {}, tool.name).not.toHaveProperty('organization');
      }

      const warnings = stderr().split(/[\r\n]+/).filter((line) => /deprecated/.test(line));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('org API keys are deprecated, removed in 0.3.0; use a personal access token');
      expect(stderr()).not.toContain('rk_test_e2e');
    } finally {
      await close();
      await api.close();
    }
  });

  async function startAndFail(env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const child = spawn(process.execPath, [BUNDLE], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exitCode = await new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)));
    return { exitCode, stdout, stderr };
  }

  it('refuses to start with both credentials set, naming both variables', async () => {
    const run = await startAndFail({ ROOTKEY_TOKEN: PAT, ROOTKEY_API_KEY: 'rk_test_e2e' });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('configuration error');
    expect(run.stderr).toContain('ROOTKEY_TOKEN');
    expect(run.stderr).toContain('ROOTKEY_API_KEY');
    expect(run.stderr).not.toContain(PAT);
    expect(run.stdout).toBe('');
  });

  it('refuses a malformed token without echoing it', async () => {
    const bad = `rk_pat_${'z'.repeat(64)}`;
    const run = await startAndFail({ ROOTKEY_TOKEN: bad });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('ROOTKEY_TOKEN');
    expect(run.stderr).not.toContain(bad);
    expect(run.stdout).toBe('');
  });

  it('starts an organization API key setup even when ROOTKEY_ORGANIZATION and ROOTKEY_TEST_MODE hold anything at all', async () => {
    const { client, stderr, close } = await connectWithStderr({
      ROOTKEY_API_KEY: 'rk_test_e2e',
      ROOTKEY_ORGANIZATION: 'My Company',
      ROOTKEY_TEST_MODE: 'staging',
    });
    try {
      expect((await client.listTools()).tools).toHaveLength(29);
      const ignored = stderr().split(/[\r\n]+/).filter((line) => /is ignored with an organization API key/.test(line));
      expect(ignored).toHaveLength(2);
    } finally {
      await close();
    }
  });

  it('refuses a malformed ROOTKEY_ORGANIZATION before serving anything', async () => {
    const run = await startAndFail({ ROOTKEY_TOKEN: PAT, ROOTKEY_ORGANIZATION: 'not an id' });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('ROOTKEY_ORGANIZATION');
    expect(run.stdout).toBe('');
  });
});
