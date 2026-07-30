import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { vi } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { setLogLevel } from '../src/log.js';
import { buildServer } from '../src/server.js';

// Keep retry and failure logging out of the test output.
setLogLevel('silent');

export interface CapturedRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: FormData | string | undefined;
}

export interface StubResponse {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** Thrown instead of returning a response, to simulate a transport failure. */
  networkError?: Error;
}

export interface FetchStub {
  calls: CapturedRequest[];
  /** Responses are consumed in order; the last one repeats once the queue is drained. */
  queue: StubResponse[];
}

export function stubFetch(responses: StubResponse[]): FetchStub {
  const stub: FetchStub = { calls: [], queue: [...responses] };

  vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    stub.calls.push({
      url,
      method: init.method ?? 'GET',
      headers,
      body: init.body as FormData | string | undefined,
    });

    const next = stub.queue.length > 1 ? stub.queue.shift()! : (stub.queue[0] ?? { status: 200, json: {} });
    if (next.networkError) throw next.networkError;

    const body = next.text ?? (next.json === undefined ? '' : JSON.stringify(next.json));
    return new Response(body, {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  });

  return stub;
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ ROOTKEY_API_KEY: 'rk_test_unit', ROOTKEY_LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv),
    ...overrides,
  };
}

/** Connects a real MCP client to the real server over an in-memory transport pair. */
export async function connectTestClient(config: Config = testConfig()): Promise<{
  client: Client;
  toolNames: string[];
  close: () => Promise<void>;
}> {
  const { server, toolNames } = buildServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    toolNames,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export function textOf(result: CallToolResult): string {
  return result.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** Parses the JSON payload block of a tool result (the last text part). */
export function payloadOf(result: CallToolResult): unknown {
  const texts = result.content.filter((part): part is { type: 'text'; text: string } => part.type === 'text');
  const last = texts[texts.length - 1];
  return last ? JSON.parse(last.text) : undefined;
}
