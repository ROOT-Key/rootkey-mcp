import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectTestClient, payloadOf, stubFetch, testConfig, textOf, type FetchStub } from './helpers.js';

const VAULT = '0xdf67CA8286510997567685c0385ECeAb11C23C92';

const EXPECTED_TOOLS = [
  'create_vault',
  'update_vault',
  'delete_vault',
  'list_files',
  'upload_file',
  'get_file',
  'download_file',
  'delete_file',
  'list_file_versions',
  'upload_file_version',
  'validate_file',
  'get_file_history',
  'get_file_validations',
  'generate_file_audit_report',
  'list_records',
  'create_record',
  'list_record_versions',
  'get_record_history',
  'get_record_validations',
  'delete_record',
  'list_recovery_points',
  'create_recovery_point',
  'get_recovery_point',
  'download_recovery_point',
  'delete_recovery_point',
  'get_environment_info',
];

const READ_ONLY_TOOLS = [
  'list_files',
  'get_file',
  'download_file',
  'list_file_versions',
  'get_file_history',
  'get_file_validations',
  'list_records',
  'list_record_versions',
  'get_record_history',
  'get_record_validations',
  'list_recovery_points',
  'get_recovery_point',
  'download_recovery_point',
  'get_environment_info',
];

const page = (data: unknown[]) => ({ data, pagination: { previousCursor: null, nextCursor: null }, metadata: {} });

async function withClient(
  responses: Parameters<typeof stubFetch>[0],
  run: (call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>, stub: FetchStub) => Promise<void>,
  config = testConfig(),
): Promise<void> {
  const stub = stubFetch(responses);
  const { client, close } = await connectTestClient(config);
  try {
    await run(
      (name, args = {}) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
      stub,
    );
  } finally {
    await close();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tool registration', () => {
  it('exposes every documented API operation plus the local diagnostics tool', async () => {
    const { client, close } = await connectTestClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
      expect(tools).toHaveLength(26);
    } finally {
      await close();
    }
  });

  it('hides every write tool in read-only mode instead of refusing at call time', async () => {
    const { client, close } = await connectTestClient(testConfig({ readOnly: true }));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...READ_ONLY_TOOLS].sort());
      expect(tools).toHaveLength(14);
    } finally {
      await close();
    }
  });

  it('annotates reads, deletes and the local tool correctly', async () => {
    const { client, close } = await connectTestClient();
    try {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));

      expect(byName.get('list_files')?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get('delete_vault')?.annotations?.destructiveHint).toBe(true);
      expect(byName.get('delete_file')?.annotations?.destructiveHint).toBe(true);
      expect(byName.get('delete_record')?.annotations?.destructiveHint).toBe(true);
      expect(byName.get('delete_recovery_point')?.annotations?.destructiveHint).toBe(true);
      expect(byName.get('upload_file')?.annotations?.destructiveHint).toBe(false);
      expect(byName.get('get_environment_info')?.annotations?.openWorldHint).toBe(false);
      expect(byName.get('list_files')?.annotations?.openWorldHint).toBe(true);

      for (const tool of tools) {
        expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
        expect(tool.annotations?.title, `${tool.name} needs a title`).toBeTruthy();
      }
    } finally {
      await close();
    }
  });
});

describe('vault address mapping', () => {
  it('sends vaultAddress as ownerVault when fetching a file', async () => {
    await withClient([{ json: { chainId: 137, file: { id: 'f1' } } }], async (call, stub) => {
      await call('get_file', { fileId: 'f1', vaultAddress: VAULT });
      const url = stub.calls[0]!.url;
      expect(url.pathname).toBe('/api-v1/platform/files/f1');
      expect(url.searchParams.get('ownerVault')).toBe(VAULT);
    });
  });

  it('sends vaultAddress as ownerAddress when deleting a file', async () => {
    await withClient([{ json: { chainId: 137 } }], async (call, stub) => {
      await call('delete_file', { fileId: 'f1', vaultAddress: VAULT });
      expect(stub.calls[0]!.method).toBe('DELETE');
      expect(stub.calls[0]!.url.searchParams.get('ownerAddress')).toBe(VAULT);
    });
  });

  it('sends vaultAddress as ownerAddress when deleting a record', async () => {
    await withClient([{ json: { chainId: 137, recordId: 'r1' } }], async (call, stub) => {
      await call('delete_record', { recordId: 'r1', vaultAddress: VAULT });
      expect(stub.calls[0]!.url.searchParams.get('ownerAddress')).toBe(VAULT);
    });
  });

  it('sends vaultAddress as a query parameter when listing files', async () => {
    await withClient([{ json: { chainId: 137, files: page([]) } }], async (call, stub) => {
      await call('list_files', { vaultAddress: VAULT, limit: 5, order: 'asc', status: 'pending' });
      const url = stub.calls[0]!.url;
      expect(url.searchParams.get('vaultAddress')).toBe(VAULT);
      expect(url.searchParams.get('limit')).toBe('5');
      expect(url.searchParams.get('order')).toBe('asc');
      expect(url.searchParams.get('status')).toBe('pending');
    });
  });

  it('puts the vault address in the path when updating a vault', async () => {
    await withClient([{ json: { walletAddress: VAULT, name: 'renamed' } }], async (call, stub) => {
      await call('update_vault', { vaultAddress: VAULT, name: 'renamed' });
      expect(stub.calls[0]!.url.pathname).toBe(`/api-v1/platform/vaults/${VAULT}`);
      expect(stub.calls[0]!.body).toBe(JSON.stringify({ name: 'renamed' }));
    });
  });

  it('interpolates a record id into the paths the spec spells fileId', async () => {
    await withClient([{ json: { chainId: 137, history: page([]) } }], async (call, stub) => {
      await call('get_record_history', { recordId: 'rec-42' });
      expect(stub.calls[0]!.url.pathname).toBe('/api-v1/platform/records/rec-42/history');
    });
  });
});

describe('argument validation', () => {
  it('rejects update_vault with neither name nor description', async () => {
    await withClient([{ json: {} }], async (call, stub) => {
      const result = await call('update_vault', { vaultAddress: VAULT });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('at least one');
      expect(stub.calls).toHaveLength(0);
    });
  });

  it('rejects a partial recovery point with no vaults listed', async () => {
    await withClient([{ json: {} }], async (call, stub) => {
      const result = await call('create_recovery_point', { name: 'backup', scope: 'partial' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('at least one vault');
      expect(stub.calls).toHaveLength(0);
    });
  });

  it('rejects an empty record payload', async () => {
    await withClient([{ json: {} }], async (call) => {
      const result = await call('create_record', { vaultAddress: VAULT, recordData: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('at least one field');
    });
  });

  it('reports a missing upload file without calling the API', async () => {
    await withClient([{ json: {} }], async (call, stub) => {
      const result = await call('upload_file', {
        filePath: path.join(tmpdir(), 'definitely-missing-rootkey-test.bin'),
        vaultAddress: VAULT,
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('No file found');
      expect(stub.calls).toHaveLength(0);
    });
  });
});

describe('uploads', () => {
  it('builds the multipart body the API expects and looks the file up afterwards', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rootkey-upload-'));
    const filePath = path.join(dir, 'contract.pdf');
    await writeFile(filePath, 'pdf-bytes');

    await withClient(
      [
        { json: { chainId: 137, transactionHash: '0xhash' } },
        { json: { chainId: 137, files: page([{ id: 'f9', name: 'contract.pdf' }]) } },
      ],
      async (call, stub) => {
        const result = await call('upload_file', { filePath, vaultAddress: VAULT });

        const upload = stub.calls[0]!;
        expect(upload.method).toBe('POST');
        expect(upload.url.pathname).toBe('/api-v1/platform/files');
        const form = upload.body as FormData;
        expect(form).toBeInstanceOf(FormData);
        expect(form.get('ownerVault')).toBe(VAULT);
        expect(form.get('fileName')).toBe('contract.pdf');
        expect(form.get('file')).toBeInstanceOf(Blob);

        // Second call is the id lookup.
        expect(stub.calls[1]!.url.searchParams.get('name')).toBe('contract.pdf');

        const payload = payloadOf(result) as { transactionHash: string; file: { id: string } };
        expect(payload.transactionHash).toBe('0xhash');
        expect(payload.file.id).toBe('f9');
      },
    );
  });

  it('honours a fileName override', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rootkey-upload-'));
    const filePath = path.join(dir, 'tmp-name.bin');
    await writeFile(filePath, 'x');

    await withClient(
      [{ json: { chainId: 137, transactionHash: '0xhash' } }, { json: { chainId: 137, files: page([]) } }],
      async (call, stub) => {
        await call('upload_file', { filePath, vaultAddress: VAULT, fileName: 'invoice-2026.pdf' });
        expect((stub.calls[0]!.body as FormData).get('fileName')).toBe('invoice-2026.pdf');
      },
    );
  });

  it('still succeeds, with a note, when the follow-up lookup finds nothing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rootkey-upload-'));
    const filePath = path.join(dir, 'a.txt');
    await writeFile(filePath, 'x');

    await withClient(
      [{ json: { chainId: 137, transactionHash: '0xhash' } }, { status: 500, text: 'boom' }],
      async (call) => {
        const result = await call('upload_file', { filePath, vaultAddress: VAULT });
        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toContain('list_files');
        expect((payloadOf(result) as { file: unknown }).file).toBeNull();
      },
    );
  });

  /**
   * The API's `name` filter is `contains`, case-insensitive, so the rows that come back are candidates
   * rather than answers. The id we pick is handed to the model and ends up in get_file and delete_file,
   * so these three pin down that a near-miss is reported as "not found" instead of as a file.
   */
  it('never reports a same-named file of a different size as the one just uploaded', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rootkey-upload-'));
    const filePath = path.join(dir, 'report.pdf');
    await writeFile(filePath, 'nine-byte');

    await withClient(
      [
        { json: { chainId: 137, transactionHash: '0xhash' } },
        { json: { chainId: 137, files: page([{ id: 'older', name: 'report.pdf', sizeBytes: 4096 }]) } },
      ],
      async (call) => {
        const result = await call('upload_file', { filePath, vaultAddress: VAULT });

        expect(result.isError).toBeFalsy();
        expect((payloadOf(result) as { file: unknown }).file).toBeNull();
        expect(textOf(result)).toContain('list_files');
      },
    );
  });

  it('never reports a merely name-containing neighbour as the one just uploaded', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rootkey-upload-'));
    const filePath = path.join(dir, 'report.pdf');
    await writeFile(filePath, 'x');

    await withClient(
      [
        { json: { chainId: 137, transactionHash: '0xhash' } },
        { json: { chainId: 137, files: page([{ id: 'neighbour', name: 'report.pdf.bak', sizeBytes: 1 }]) } },
      ],
      async (call) => {
        const result = await call('upload_file', { filePath, vaultAddress: VAULT });
        expect((payloadOf(result) as { file: unknown }).file).toBeNull();
      },
    );
  });

  it('accepts an exact name and size match, and tolerates a row that omits the size', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rootkey-upload-'));
    const filePath = path.join(dir, 'report.pdf');
    await writeFile(filePath, 'nine-byte');

    await withClient(
      [
        { json: { chainId: 137, transactionHash: '0xhash' } },
        {
          json: {
            chainId: 137,
            files: page([
              { id: 'no-size', name: 'report.pdf' },
              { id: 'exact', name: 'report.pdf', sizeBytes: 9 },
            ]),
          },
        },
      ],
      async (call) => {
        const result = await call('upload_file', { filePath, vaultAddress: VAULT });
        // Newest first: a row that does not report a size cannot be ruled out, so it wins.
        expect((payloadOf(result) as { file: { id: string } }).file.id).toBe('no-size');
      },
    );
  });

  it('sends the validation method, defaulting to hash', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rootkey-validate-'));
    const filePath = path.join(dir, 'a.txt');
    await writeFile(filePath, 'x');

    await withClient(
      [{ json: { chainId: 137, result: { ownership: true, integrity: true, validity: true } } }],
      async (call, stub) => {
        await call('validate_file', { fileId: 'f1', filePath, vaultAddress: VAULT });
        const form = stub.calls[0]!.body as FormData;
        expect(form.get('method')).toBe('hash');
        expect(form.get('ownerVault')).toBe(VAULT);
      },
    );
  });
});

describe('records', () => {
  it('reports an exact match when the created row is found', async () => {
    await withClient(
      [
        { json: { chainId: 137 } },
        { json: { chainId: 137, records: page([{ __meta: { id: 'r5' }, invoice: 'INV-1', total: 10 }]) } },
      ],
      async (call, stub) => {
        const result = await call('create_record', {
          vaultAddress: VAULT,
          recordData: { invoice: 'INV-1', total: 10 },
        });

        expect(stub.calls[0]!.body).toBe(
          JSON.stringify({ ownerVault: VAULT, recordData: { invoice: 'INV-1', total: 10 } }),
        );
        const payload = payloadOf(result) as { matched: string; record: { __meta: { id: string } } };
        expect(payload.matched).toBe('exact');
        expect(payload.record.__meta.id).toBe('r5');
      },
    );
  });

  it('falls back to the newest row and says so when no exact match is found', async () => {
    await withClient(
      [
        { json: { chainId: 137 } },
        { json: { chainId: 137, records: page([{ __meta: { id: 'r9' }, invoice: 'OTHER' }]) } },
      ],
      async (call) => {
        const result = await call('create_record', { vaultAddress: VAULT, recordData: { invoice: 'INV-2' } });
        expect(textOf(result)).toContain('newest row');
        expect((payloadOf(result) as { matched: string }).matched).toBe('newest');
      },
    );
  });

  it('does not fail the tool when the lookup errors', async () => {
    await withClient([{ json: { chainId: 137 } }, { status: 503, text: '' }], async (call) => {
      const result = await call('create_record', { vaultAddress: VAULT, recordData: { a: 1 } });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('list_records');
    });
  });
});

describe('recovery points', () => {
  it('headlines the one-time password and keeps it out of the logs', async () => {
    await withClient(
      [{ status: 202, json: { password: 'super-secret-pw' } }, { json: { recoveryPoints: [{ id: 'rp1', name: 'july' }] } }],
      async (call, stub) => {
        const result = await call('create_recovery_point', { name: 'july', scope: 'global' });

        expect(textOf(result)).toContain('ONE-TIME PASSWORD');
        expect(textOf(result)).toContain('super-secret-pw');
        expect(stub.calls[0]!.body).toBe(JSON.stringify({ name: 'july', scope: 'global' }));
        expect((payloadOf(result) as { recoveryPoint: { id: string } }).recoveryPoint.id).toBe('rp1');
      },
    );
  });

  it('flattens the time range into the nested shape the API expects', async () => {
    await withClient(
      [{ status: 202, json: { password: 'pw' } }, { json: { recoveryPoints: [] } }],
      async (call, stub) => {
        await call('create_recovery_point', {
          name: 'window',
          scope: 'partial',
          vaults: [VAULT],
          timeRangeStart: '2026-07-01T00:00:00Z',
          timeRangeEnd: '2026-07-31T00:00:00Z',
        });

        expect(JSON.parse(stub.calls[0]!.body as string)).toEqual({
          name: 'window',
          scope: 'partial',
          vaults: [VAULT],
          timeRange: { start: '2026-07-01T00:00:00Z', end: '2026-07-31T00:00:00Z' },
        });
      },
    );
  });

  it('unwraps the list envelope of the unpaginated recovery point endpoint', async () => {
    await withClient([{ json: { recoveryPoints: [{ id: 'rp1' }, { id: 'rp2' }] } }], async (call) => {
      const result = await call('list_recovery_points', {});
      expect((payloadOf(result) as { items: unknown[] }).items).toHaveLength(2);
    });
  });
});

describe('downloads', () => {
  it('streams a file to disk and returns the path instead of the bytes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rootkey-download-'));

    await withClient(
      [{ text: 'file-contents', headers: { 'content-disposition': 'attachment; filename="anchor.txt"' } }],
      async (call) => {
        const result = await call('download_file', { fileId: 'f1', outputPath: dir });
        const payload = payloadOf(result) as { savedPath: string; sizeBytes: number };

        expect(payload.savedPath).toBe(path.join(dir, 'anchor.txt'));
        expect(payload.sizeBytes).toBe(13);
        expect(await readFile(payload.savedPath, 'utf8')).toBe('file-contents');
        expect(textOf(result)).not.toContain('file-contents');
      },
    );
  });
});

describe('error surfacing', () => {
  it('turns an API error envelope into a readable tool error', async () => {
    await withClient(
      [
        {
          status: 400,
          json: { error: { message: 'Vault not found', errorCode: 'resource_not_found', requestId: 'req-9' } },
        },
      ],
      async (call) => {
        const result = await call('list_files', { vaultAddress: VAULT });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('resource_not_found');
        expect(textOf(result)).toContain('req-9');
      },
    );
  });

  it('explains that a queued audit report is only available in the dashboard', async () => {
    await withClient([{ status: 202, json: { reportId: 'rep-1', status: 'PENDING' } }], async (call) => {
      const result = await call('generate_file_audit_report', { fileId: 'f1', framework: 'DORA' });
      expect(textOf(result)).toContain('dashboard');
      expect((payloadOf(result) as { reportId: string }).reportId).toBe('rep-1');
    });
  });
});

describe('get_environment_info', () => {
  it('reports configuration without leaking the key', async () => {
    const { client, close } = await connectTestClient(testConfig({ readOnly: false }));
    try {
      const result = (await client.callTool({ name: 'get_environment_info', arguments: {} })) as CallToolResult;
      const payload = payloadOf(result) as Record<string, unknown>;

      expect(payload.keyMode).toBe('test');
      expect(payload.environment).toBe('production');
      expect(payload.registeredTools).toBe(26);
      expect(payload.readOnlyMode).toBe(false);
      expect(JSON.stringify(payload)).not.toContain('rk_test_unit');
    } finally {
      await close();
    }
  });
});

/**
 * These assertions exist because the descriptions are what the model acts on, and two of them used to
 * be wrong: records were described as anchored on chain (the API stores and hashes them, but writes no
 * transaction), and deletes were described as permanent (they are soft, and the Restore Center undoes
 * them). Both are compliance-shaped claims, so they get a regression test rather than a code comment.
 */
describe('description accuracy', () => {
  it('never claims records are anchored on chain', async () => {
    const { client, close } = await connectTestClient();
    try {
      const { tools } = await client.listTools();
      const createRecord = tools.find((tool) => tool.name === 'create_record');

      expect(createRecord?.description).toContain('NOT anchored on chain');
      expect(createRecord?.description).not.toMatch(/table and anchor it/i);
      expect(client.getInstructions() ?? '').toContain('Records are NOT anchored on chain');
    } finally {
      await close();
    }
  });

  it('describes vault, file and record deletes as recoverable, and recovery point deletes as not', async () => {
    const { client, close } = await connectTestClient();
    try {
      const { tools } = await client.listTools();
      const describe_ = (name: string) => tools.find((tool) => tool.name === name)?.description ?? '';

      for (const name of ['delete_vault', 'delete_file', 'delete_record']) {
        expect(describe_(name), name).toContain('Restore Center');
        expect(describe_(name), name).not.toMatch(/permanently delete/i);
        expect(describe_(name), name).not.toMatch(/audited on chain/i);
      }

      expect(describe_('delete_recovery_point')).toMatch(/genuinely irreversible/i);
      expect(describe_('delete_recovery_point')).not.toContain('Restore Center entry for it.\nRecoverable');
    } finally {
      await close();
    }
  });

  it('keeps every delete tool annotated as destructive regardless of recoverability', async () => {
    const { client, close } = await connectTestClient();
    try {
      const { tools } = await client.listTools();
      const deletes = tools.filter((tool) => tool.name.startsWith('delete_'));

      expect(deletes).toHaveLength(4);
      for (const tool of deletes) {
        expect(tool.annotations?.destructiveHint, tool.name).toBe(true);
      }
    } finally {
      await close();
    }
  });
});
