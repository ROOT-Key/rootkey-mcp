import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import spec from './fixtures/openapi-v2.json' with { type: 'json' };
import { connectTestClient, stubFetch, type CapturedRequest } from './helpers.js';

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

/** Reaches the API but adds no operation of its own: it polls the documented fetch endpoint. */
const HELPERS: Record<string, string> = {
  rootkey_wait_for_recovery_point: 'GET /platform/recovery-point/{recoveryPointId}',
};

/** Answers from configuration alone and never opens a socket. */
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
    route = route.split(`/${value}`).join(`/{${parameter}}`);
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

async function captureFirstRequest(
  tool: string,
  expectation: Expectation,
  scratchDir: string,
): Promise<CapturedRequest> {
  const args: Record<string, unknown> = { ...expectation.args };
  if (args.filePath === '<file>') args.filePath = path.join(scratchDir, 'sample.txt');
  if (args.outputPath === '<dir>') args.outputPath = scratchDir;

  const stub = stubFetch(expectation.responses ?? [{ json: {} }]);
  const { client, close } = await connectTestClient();
  try {
    const result = (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
    expect(result.isError, `${tool} errored: ${JSON.stringify(result.content)}`).toBeFalsy();
    expect(stub.calls.length, `${tool} made no request`).toBeGreaterThan(0);
    return stub.calls[0]!;
  } finally {
    await close();
  }
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
      const accounted = [...Object.keys(EXPECTATIONS), ...Object.keys(HELPERS), ...LOCAL_ONLY].sort();
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
