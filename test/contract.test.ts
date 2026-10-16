import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import spec from './fixtures/openapi-v2.json' with { type: 'json' };
import { ORG_A, TEST_PAT, connectTestClient, patConfig, stubFetch, testConfig, type CapturedRequest } from './helpers.js';
import type { Config } from '../src/config.js';

/**
 * The whole value of this server is being a faithful translation of the documented ROOTKey API, and
 * nothing tested that. The tool-count assertions catch a tool going missing; they say nothing about a
 * tool that quietly sends `ownerAddress` where the spec says `ownerVault`, which is the mistake this
 * API's three near-identical parameter names invite.
 *
 * So: drive every tool against a stubbed transport, capture what it actually put on the wire, and
 * check it against the spec - method, path, and every parameter the spec marks required. Then check
 * the reverse, that no documented operation has been left without a tool.
 *
 * The fixture is a copy of api-reference/openapi-v2.json from ROOT-Key/docs. Refresh it when the
 * public API changes; a diff here is the point, not an inconvenience.
 */

const VAULT = '0xdf67CA8286510997567685c0385ECeAb11C23C92';

const SAMPLES: Record<string, string> = {
  vaultAddress: VAULT,
  fileId: 'file-sample',
  parentId: 'parent-sample',
  recordId: 'record-sample',
  recoveryPointId: 'rp-sample',
};

interface Expectation {
  /** The documented operation, as `METHOD /path/{template}`. */
  operation: string;
  args: Record<string, unknown>;
  /** Responses to feed the stub, when the tool needs more than a bare 200. */
  responses?: Parameters<typeof stubFetch>[0];
}

const upload = { json: { chainId: 137, transactionHash: '0x1' } };
const emptyFiles = { json: { chainId: 137, files: { data: [], pagination: {}, metadata: {} } } };
const emptyRecords = { json: { chainId: 137, records: { data: [], pagination: {}, metadata: {} } } };

// Every tool that talks to the API, and the documented operation it must hit.
const EXPECTATIONS: Record<string, Expectation> = {
  rootkey_create_vault: { operation: 'POST /platform/vaults', args: { vaultName: 'v' } },
  rootkey_update_vault: {
    operation: 'PUT /platform/vaults/{vaultAddress}',
    args: { vaultAddress: VAULT, name: 'renamed' },
  },
  rootkey_delete_vault: {
    operation: 'DELETE /platform/vaults/{vaultAddress}',
    args: { vaultAddress: VAULT },
  },

  rootkey_list_files: { operation: 'GET /platform/files', args: { vaultAddress: VAULT } },
  rootkey_upload_file: {
    operation: 'POST /platform/files',
    args: { vaultAddress: VAULT, filePath: '<file>' },
    responses: [upload, emptyFiles],
  },
  rootkey_get_file: {
    operation: 'GET /platform/files/{fileId}',
    args: { fileId: SAMPLES.fileId, vaultAddress: VAULT },
  },
  rootkey_download_file: {
    operation: 'GET /platform/files/{fileId}/download',
    args: { fileId: SAMPLES.fileId, outputPath: '<dir>' },
    responses: [{ text: 'bytes' }],
  },
  rootkey_delete_file: {
    operation: 'DELETE /platform/files/{fileId}',
    args: { fileId: SAMPLES.fileId, vaultAddress: VAULT },
  },
  rootkey_list_file_versions: {
    operation: 'GET /platform/files/{parentId}/versions',
    args: { parentId: SAMPLES.parentId, vaultAddress: VAULT },
  },
  rootkey_upload_file_version: {
    operation: 'POST /platform/files/{parentId}/versions',
    args: { parentId: SAMPLES.parentId, vaultAddress: VAULT, filePath: '<file>' },
    responses: [upload, emptyFiles],
  },
  rootkey_validate_file: {
    operation: 'POST /platform/files/{fileId}/validate',
    args: { fileId: SAMPLES.fileId, vaultAddress: VAULT, filePath: '<file>' },
  },
  rootkey_get_file_history: {
    operation: 'GET /platform/files/{fileId}/history',
    args: { fileId: SAMPLES.fileId },
  },
  rootkey_get_file_validations: {
    operation: 'GET /platform/files/{fileId}/validations',
    args: { fileId: SAMPLES.fileId },
  },
  rootkey_generate_file_audit_report: {
    operation: 'POST /platform/files/{fileId}/audit-report',
    args: { fileId: SAMPLES.fileId },
  },

  rootkey_list_records: { operation: 'GET /platform/records', args: { vaultAddress: VAULT } },
  rootkey_create_record: {
    operation: 'POST /platform/records',
    args: { vaultAddress: VAULT, recordData: { reference: 'r1' } },
    responses: [{ json: { chainId: 137 } }, emptyRecords],
  },
  rootkey_list_record_versions: {
    operation: 'GET /platform/records/{parentId}/versions',
    args: { parentId: SAMPLES.parentId, vaultAddress: VAULT },
  },
  rootkey_get_record_history: {
    operation: 'GET /platform/records/{fileId}/history',
    args: { recordId: SAMPLES.fileId },
  },
  rootkey_get_record_validations: {
    operation: 'GET /platform/records/{fileId}/validations',
    args: { recordId: SAMPLES.fileId },
  },
  rootkey_delete_record: {
    operation: 'DELETE /platform/records/{recordId}',
    args: { recordId: SAMPLES.recordId, vaultAddress: VAULT },
  },

  rootkey_list_recovery_points: { operation: 'GET /platform/recovery-point', args: {} },
  rootkey_create_recovery_point: {
    operation: 'POST /platform/recovery-point',
    args: { name: 'backup', scope: 'global' },
    responses: [{ json: { password: 'p' } }, { json: { recoveryPoints: [] } }],
  },
  rootkey_get_recovery_point: {
    operation: 'GET /platform/recovery-point/{recoveryPointId}',
    args: { recoveryPointId: SAMPLES.recoveryPointId },
  },
  rootkey_download_recovery_point: {
    operation: 'GET /platform/recovery-point/{recoveryPointId}/download',
    args: { recoveryPointId: SAMPLES.recoveryPointId, outputPath: '<dir>' },
    responses: [{ text: 'bytes' }],
  },
  rootkey_delete_recovery_point: {
    operation: 'DELETE /platform/recovery-point/{recoveryPointId}',
    args: { recoveryPointId: SAMPLES.recoveryPointId },
  },
};

/**
 * Delegated access (personal access tokens): the operations this version added ahead of the public docs, so the
 * spec fixture does not list them yet. The first test below fails the day the fixture learns them, which is the
 * prompt to move each into EXPECTATIONS where it is held to the documented parameters.
 *
 * Until then these rows and the hand-written stub answers in tools.test.ts prove that this server matches its own
 * reading of the contract, not the backend. Replace the stubs with answers recorded from the backend's own end to end
 * run before 0.2.0 is published.
 */
const DELEGATED_ACCESS: Record<string, Expectation> = {
  rootkey_list_organizations: { operation: 'GET /organizations', args: {} },
  rootkey_list_vaults: { operation: 'GET /vaults', args: {} },
  rootkey_list_tables: { operation: 'GET /tables', args: {} },
};

/** Reaches the API but adds no operation of its own: it polls the documented fetch endpoint. */
const HELPERS: Record<string, string> = {
  rootkey_wait_for_recovery_point: 'GET /platform/recovery-point/{recoveryPointId}',
};

/**
 * Answers from configuration alone under an organization API key and never opens a socket. Under a personal access
 * token it asks GET /me and GET /organization, which the next block covers.
 */
const LOCAL_ONLY = ['rootkey_get_environment_info'];

interface SpecOperation {
  parameters?: unknown[];
  requestBody?: unknown;
}

function deref<T>(node: unknown): T {
  if (node && typeof node === 'object' && '$ref' in (node as Record<string, unknown>)) {
    const segments = String((node as { $ref: string }).$ref).replace('#/', '').split('/');
    let cursor: unknown = spec;
    for (const segment of segments) cursor = (cursor as Record<string, unknown>)[segment];
    return deref<T>(cursor);
  }
  return node as T;
}

function specOperations(): Map<string, SpecOperation> {
  const found = new Map<string, SpecOperation>();
  const paths = spec.paths as unknown as Record<string, Record<string, unknown>>;

  for (const [route, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      found.set(`${method.toUpperCase()} ${route}`, operation as SpecOperation);
    }
  }
  return found;
}

/** `/api-v1/platform/files/file-sample/history` becomes `/platform/files/{fileId}/history`. */
function toTemplate(pathname: string): string {
  let route = pathname.replace(/^\/api-v1/, '');
  for (const [parameter, value] of Object.entries(SAMPLES)) {
    route = route.split(`/${value}`).join(`/{${parameter}}`).split(`/${value.toLowerCase()}`).join(`/{${parameter}}`);
  }
  return route;
}

function requiredQuery(operation: SpecOperation): string[] {
  return (operation.parameters ?? [])
    .map((parameter) => deref<{ in: string; name: string; required?: boolean }>(parameter))
    .filter((parameter) => parameter.in === 'query' && parameter.required === true)
    .map((parameter) => parameter.name);
}

function requiredBodyFields(operation: SpecOperation): { fields: string[]; multipart: boolean } {
  if (!operation.requestBody) return { fields: [], multipart: false };

  const body = deref<{ content?: Record<string, { schema: unknown }> }>(operation.requestBody);
  const entry = Object.entries(body.content ?? {})[0];
  if (!entry) return { fields: [], multipart: false };

  const [mediaType, media] = entry;
  const schema = deref<{ required?: string[] }>(media.schema);
  return { fields: schema.required ?? [], multipart: mediaType.startsWith('multipart/') };
}

/** Every request a tool put on the wire, follow-up lookups included. */
async function captureRequests(
  tool: string,
  expectation: Expectation,
  scratchDir: string,
  config: Config = testConfig(),
  onResult?: (result: CallToolResult) => void,
): Promise<CapturedRequest[]> {
  const args: Record<string, unknown> = { ...expectation.args };
  if (args.filePath === '<file>') args.filePath = path.join(scratchDir, 'sample.txt');
  if (args.outputPath === '<dir>') args.outputPath = scratchDir;

  const stub = stubFetch(expectation.responses ?? [{ json: {} }]);
  const { client, close } = await connectTestClient(config);
  try {
    const result = (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
    expect(result.isError, `${tool} errored: ${JSON.stringify(result.content)}`).toBeFalsy();
    expect(stub.calls.length, `${tool} made no request`).toBeGreaterThan(0);
    onResult?.(result);
    return stub.calls;
  } finally {
    await close();
  }
}

async function captureFirstRequest(
  tool: string,
  expectation: Expectation,
  scratchDir: string,
): Promise<CapturedRequest> {
  return (await captureRequests(tool, expectation, scratchDir))[0]!;
}

async function scratch(): Promise<string> {
  const scratchDir = await mkdtemp(path.join(tmpdir(), 'rootkey-contract-'));
  await writeFile(path.join(scratchDir, 'sample.txt'), 'sample');
  return scratchDir;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAPI contract', () => {
  const operations = specOperations();

  it('covers every documented operation, and invents none', () => {
    const claimed = new Set([
      ...Object.values(EXPECTATIONS).map((expectation) => expectation.operation),
      ...Object.values(HELPERS),
    ]);

    expect([...claimed].sort()).toEqual([...operations.keys()].sort());
  });

  it('accounts for every registered tool', async () => {
    const { client, close } = await connectTestClient();
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      // An organization API key is not offered the organization listing; the token half is checked below.
      const accounted = [
        ...Object.keys(EXPECTATIONS),
        ...Object.keys(DELEGATED_ACCESS).filter((name) => name !== 'rootkey_list_organizations'),
        ...Object.keys(HELPERS),
        ...LOCAL_ONLY,
      ].sort();
      expect(names).toEqual(accounted);
    } finally {
      await close();
    }
  });

  for (const [tool, expectation] of Object.entries(EXPECTATIONS)) {
    it(`${tool} calls ${expectation.operation} with everything the spec requires`, async () => {
      const scratchDir = await mkdtemp(path.join(tmpdir(), 'rootkey-contract-'));
      await writeFile(path.join(scratchDir, 'sample.txt'), 'sample');

      const request = await captureFirstRequest(tool, expectation, scratchDir);
      const [expectedMethod, expectedRoute] = expectation.operation.split(' ') as [string, string];

      expect(request.method).toBe(expectedMethod);
      expect(toTemplate(request.url.pathname)).toBe(expectedRoute);

      const operation = operations.get(expectation.operation);
      expect(operation, `${expectation.operation} is not in the spec`).toBeDefined();

      for (const parameter of requiredQuery(operation as SpecOperation)) {
        expect(request.url.searchParams.get(parameter), `${tool} must send ?${parameter}`).toBeTruthy();
      }

      const { fields, multipart } = requiredBodyFields(operation as SpecOperation);
      for (const field of fields) {
        if (multipart) {
          expect((request.body as FormData).get(field), `${tool} must send ${field} in the form`).toBeTruthy();
        } else {
          const body = JSON.parse(String(request.body ?? '{}')) as Record<string, unknown>;
          expect(body[field], `${tool} must send ${field} in the body`).toBeDefined();
        }
      }
    });
  }
});

describe('delegated access operations', () => {
  const operations = specOperations();

  for (const [tool, expectation] of Object.entries(DELEGATED_ACCESS)) {
    it(`${tool} calls ${expectation.operation}, which the public spec does not document yet`, async () => {
      const request = (await captureRequests(tool, expectation, await scratch(), patConfig({ ROOTKEY_ORGANIZATION: ORG_A })))[0]!;
      const [method, route] = expectation.operation.split(' ') as [string, string];

      expect(request.method).toBe(method);
      expect(request.url.pathname).toBe(`/api-v1${route}`);
      expect(operations.has(expectation.operation), `${expectation.operation} is documented now: move it into EXPECTATIONS`).toBe(false);
    });
  }

  it('rootkey_get_environment_info asks GET /me and GET /organization under a personal access token', async () => {
    const calls = await captureRequests(
      'rootkey_get_environment_info',
      { operation: 'GET /me', args: {}, responses: [{ json: { user: {}, credential: {} } }, { json: { id: ORG_A } }] },
      await scratch(),
      patConfig({ ROOTKEY_ORGANIZATION: ORG_A }),
    );
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(['GET /api-v1/me', 'GET /api-v1/organization']);
  });
});

/**
 * The credential is the one thing every tool shares and no tool writes: it is attached by the client. So the
 * check is made for every tool, on every request it makes, under both credentials - a tool that built its own
 * request, or a follow-up lookup that forgot the headers, would be caught here and nowhere else.
 */
/** The API refuses these to every delegated credential, so a personal access token is not offered them. */
const AGENT_BLOCKED = new Set([
  'rootkey_list_recovery_points',
  'rootkey_create_recovery_point',
  'rootkey_get_recovery_point',
  'rootkey_wait_for_recovery_point',
  'rootkey_download_recovery_point',
  'rootkey_delete_recovery_point',
  'rootkey_generate_file_audit_report',
]);

/** The one tool no operation of the spec accounts for: it polls, so it makes several requests. */
const WAIT_TOOL: Expectation = {
  operation: 'GET /platform/recovery-point/{recoveryPointId}',
  args: { recoveryPointId: SAMPLES.recoveryPointId, pollIntervalSeconds: 1 },
  responses: [{ json: { recoveryPoint: { status: 'processing' } } }, { json: { recoveryPoint: { status: 'completed' } } }],
};

describe('tool availability follows the credential', () => {
  it('a personal access token gets the organization listing and none of the tools the API refuses to agents', async () => {
    const { client, close } = await connectTestClient(patConfig());
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('rootkey_list_organizations');
      for (const name of AGENT_BLOCKED) expect(names, name).not.toContain(name);
      expect(names).toHaveLength(23);
    } finally {
      await close();
    }
  });

  it('every tool in the spec that is not agent-blocked is still offered to a token', async () => {
    const { client, close } = await connectTestClient(patConfig());
    try {
      const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
      for (const name of Object.keys(EXPECTATIONS)) expect(names.has(name), name).toBe(!AGENT_BLOCKED.has(name));
    } finally {
      await close();
    }
  });
});

describe('credentials on the wire, per tool', () => {
  const everyTool = { ...EXPECTATIONS, ...DELEGATED_ACCESS, rootkey_wait_for_recovery_point: WAIT_TOOL };
  // Listing the organizations is the one call that is not made inside an organization, and the one that only a
  // personal access token has anything to answer, so it is held to the token half only.
  const NOT_ORG_SCOPED = new Set(['rootkey_list_organizations']);

  for (const [tool, expectation] of Object.entries(everyTool)) {
    // A tool that is not offered to a token (see above) has no token request to inspect.
    if (!AGENT_BLOCKED.has(tool)) {
    it(`${tool} sends the token, the organization and the namespace on every request`, async () => {
      const calls = await captureRequests(
        tool,
        expectation,
        await scratch(),
        patConfig({ ROOTKEY_ORGANIZATION: ORG_A, ROOTKEY_TEST_MODE: 'true' }),
      );

      for (const call of calls) {
        expect(call.headers.authorization, `${tool}: Authorization`).toBe(`Bearer ${TEST_PAT}`);
        expect(call.headers['x-api-key'], `${tool}: x-api-key`).toBeUndefined();
        expect(call.headers['x-rootkey-organization'], `${tool}: organization`).toBe(NOT_ORG_SCOPED.has(tool) ? undefined : ORG_A);
        expect(call.headers['x-test-mode'], `${tool}: namespace`).toBe('true');
      }
    });
    }

    if (NOT_ORG_SCOPED.has(tool)) continue;

    it(`${tool} sends only x-api-key under an organization API key`, async () => {
      const calls = await captureRequests(tool, expectation, await scratch());

      for (const call of calls) {
        expect(call.headers['x-api-key'], `${tool}: x-api-key`).toBe('rk_test_unit');
        expect(call.headers.authorization, `${tool}: Authorization`).toBeUndefined();
        expect(call.headers['x-rootkey-organization'], `${tool}: organization`).toBeUndefined();
        expect(call.headers['x-test-mode'], `${tool}: namespace`).toBeUndefined();
      }
    });
  }

  it('rootkey_get_environment_info sends the token on both of its requests, and the organization only on the second', async () => {
    const calls = await captureRequests(
      'rootkey_get_environment_info',
      { operation: 'GET /me', args: {}, responses: [{ json: { user: {}, credential: {} } }, { json: { id: ORG_A } }] },
      await scratch(),
      patConfig({ ROOTKEY_ORGANIZATION: ORG_A, ROOTKEY_TEST_MODE: 'false' }),
    );

    expect(calls.map((c) => c.url.pathname)).toEqual(['/api-v1/me', '/api-v1/organization']);
    for (const call of calls) {
      expect(call.headers.authorization).toBe(`Bearer ${TEST_PAT}`);
      expect(call.headers['x-test-mode']).toBe('false');
    }
    expect(calls[0]!.headers['x-rootkey-organization']).toBeUndefined();
    expect(calls[1]!.headers['x-rootkey-organization']).toBe(ORG_A);
  });

  it('every tool that changes something names the organization it acted in, under a token', async () => {
    const writers = Object.entries(EXPECTATIONS).filter(
      ([tool, expectation]) => !AGENT_BLOCKED.has(tool) && !expectation.operation.startsWith('GET '),
    );
    // Guard the guard: the filter must not quietly leave nothing to check.
    expect(writers.length).toBeGreaterThanOrEqual(8);

    for (const [tool, expectation] of writers) {
      let text = '';
      await captureRequests(tool, expectation, await scratch(), patConfig({ ROOTKEY_ORGANIZATION: ORG_A }), (result) => {
        text = result.content.map((part) => ('text' in part ? part.text : '')).join('\n');
      });
      expect(text, tool).toContain(`Acted in organization ${ORG_A}.`);
    }
  });

  it('the per-call organization argument beats ROOTKEY_ORGANIZATION on every request of a multi-request tool', async () => {
    const ORG_OTHER = '99999999-9999-4999-8999-999999999999';
    const scratchDir = await scratch();
    const calls = await captureRequests(
      'rootkey_upload_file',
      { ...EXPECTATIONS.rootkey_upload_file!, args: { ...EXPECTATIONS.rootkey_upload_file!.args, organization: ORG_OTHER } },
      scratchDir,
      patConfig({ ROOTKEY_ORGANIZATION: ORG_A }),
    );

    // The upload and its follow-up lookup: both in the organization the caller named.
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) expect(call.headers['x-rootkey-organization']).toBe(ORG_OTHER);
  });
});

/**
 * The API does not match the checksummed (mixed-case) and the lower-case form of an address alike everywhere, so the
 * client sends only the lower-case form: in the path, the query, the JSON body, the multipart form and the lookups a
 * tool makes after a write. Checked on every request of every tool that takes a vault or table address.
 */
describe('addresses go out lower-cased, per tool', () => {
  const withAddress = Object.entries({ ...EXPECTATIONS, ...DELEGATED_ACCESS }).filter(
    ([, expectation]) => expectation.args.vaultAddress !== undefined,
  );

  it('covers the tools that take an address', () => {
    expect(withAddress.length).toBeGreaterThanOrEqual(12);
  });

  for (const [tool, expectation] of withAddress) {
    it(`${tool} never puts the mixed-case address on the wire`, async () => {
      const calls = await captureRequests(tool, expectation, await scratch());
      const mixed = VAULT;

      for (const call of calls) {
        const form = call.body instanceof FormData ? [...call.body.entries()].map(([k, v]) => `${k}=${String(v)}`).join('&') : '';
        const wire = [decodeURIComponent(call.url.href), typeof call.body === 'string' ? call.body : '', form].join('\n');
        expect(wire, `${tool}: ${call.method} ${call.url.pathname}`).not.toContain(mixed);
      }
      const all = calls
        .map((call) => decodeURIComponent(call.url.href) + (typeof call.body === 'string' ? call.body : ''))
        .join('\n');
      const forms = calls.flatMap((call) => (call.body instanceof FormData ? [...call.body.values()].map(String) : []));
      expect([all, ...forms].join('\n')).toContain(mixed.toLowerCase());
    });
  }

  it('rootkey_create_recovery_point lower-cases the vault list too', async () => {
    const calls = await captureRequests(
      'rootkey_create_recovery_point',
      { operation: 'POST /platform/recovery-point', args: { name: 'b', scope: 'partial', vaults: [VAULT, VAULT.toUpperCase().replace('0X', '0x')] }, responses: [{ json: { password: 'p' } }, { json: { recoveryPoints: [] } }] },
      await scratch(),
    );
    const body = JSON.parse(String(calls[0]!.body)) as { vaults: string[] };
    expect(body.vaults).toEqual([VAULT.toLowerCase(), VAULT.toLowerCase()]);
  });
});
