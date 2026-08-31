import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProgressNotificationSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
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
  'wait_for_recovery_point',
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
  'wait_for_recovery_point',
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
      expect(tools).toHaveLength(27);
    } finally {
      await close();
    }
  });

  it('hides every write tool in read-only mode instead of refusing at call time', async () => {
    const { client, close } = await connectTestClient(testConfig({ readOnly: true }));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...READ_ONLY_TOOLS].sort());
      expect(tools).toHaveLength(15);
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

      // A download changes nothing in the workspace, so it survives read-only mode - but it does write
      // a file, so it cannot claim readOnlyHint. The two questions are separate and answered separately.
      expect(byName.get('download_file')?.annotations?.readOnlyHint).toBe(false);
      expect(byName.get('download_recovery_point')?.annotations?.readOnlyHint).toBe(false);
      expect(byName.get('get_file')?.annotations?.readOnlyHint).toBe(true);

      for (const tool of tools) {
        expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
        expect(tool.annotations?.title, `${tool.name} needs a title`).toBeTruthy();
      }
    } finally {
      await close();
    }
  });
});

describe('read-only mode', () => {
  it('still serves the downloads, because they change nothing in the workspace', async () => {
    const { client, close } = await connectTestClient(testConfig({ readOnly: true }));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('download_file');
      expect(names).toContain('download_recovery_point');
      expect(names).not.toContain('upload_file');
    } finally {
      await close();
    }
  });

  it('refuses a download aimed outside the download directory', async () => {
    const downloadDir = await mkdtemp(path.join(tmpdir(), 'rootkey-dl-'));
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'rootkey-elsewhere-'));

    await withClient(
      [{ text: 'file-bytes' }],
      async (call) => {
        const result = await call('download_file', {
          fileId: 'f1',
          outputPath: path.join(elsewhere, 'exfiltrated.bin'),
        });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('read-only mode');
      },
      testConfig({ readOnly: true, downloadDir }),
    );
  });

  it('still saves a download that lands inside the download directory', async () => {
    const downloadDir = await mkdtemp(path.join(tmpdir(), 'rootkey-dl-'));

    await withClient(
      [{ text: 'file-bytes' }],
      async (call) => {
        const result = await call('download_file', { fileId: 'f1' });
        expect(result.isError).toBeFalsy();
        expect((payloadOf(result) as { savedPath: string }).savedPath).toContain(downloadDir);
      },
      testConfig({ readOnly: true, downloadDir }),
    );
  });
});

describe('input schemas', () => {
  it('publishes additionalProperties: false, including for the no-argument tools', async () => {
    const { client, close } = await connectTestClient();
    try {
      const { tools } = await client.listTools();

      for (const tool of tools) {
        expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      }

      const local = tools.find((tool) => tool.name === 'get_environment_info');
      expect(local?.inputSchema).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
    } finally {
      await close();
    }
  });

  // Surfaced as a tool execution error rather than a JSON-RPC protocol error, which is the shape the
  // spec says clients should hand back to the model so it can self-correct.
  it('names the offending key when an unknown argument is passed', async () => {
    const { client, close } = await connectTestClient();
    try {
      const result = (await client.callTool({
        name: 'get_environment_info',
        arguments: { bogus: 1 },
      })) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Unrecognized key(s) in object: 'bogus'");
    } finally {
      await close();
    }
  });
});

describe('structured output', () => {
  it('declares an output schema on the tools whose payload this server shapes', async () => {
    const { client, close } = await connectTestClient();
    try {
      const { tools } = await client.listTools();
      const withSchema = new Set(tools.filter((tool) => tool.outputSchema).map((tool) => tool.name));

      for (const name of ['list_files', 'list_records', 'get_file_history', 'get_environment_info']) {
        expect(withSchema.has(name), name).toBe(true);
      }
      // Straight API pass-through: a schema here would be a guess about someone else's contract.
      for (const name of ['get_file', 'create_vault', 'validate_file']) {
        expect(withSchema.has(name), name).toBe(false);
      }
    } finally {
      await close();
    }
  });

  it('returns structuredContent alongside the text block, and keeps the API extras', async () => {
    await withClient(
      [{ json: { chainId: 137, files: page([{ id: 'f1', name: 'a.pdf' }]) } }],
      async (call) => {
        const result = await call('list_files', { vaultAddress: VAULT });
        const structured = result.structuredContent as {
          items: unknown[];
          chainId: number;
          pagination: { nextCursor: string | null };
        };

        expect(structured.items).toHaveLength(1);
        expect(structured.chainId).toBe(137);
        expect(structured.pagination.nextCursor).toBeNull();
        // The serialized copy is still there for clients that do not read structuredContent.
        expect(payloadOf(result)).toEqual(structured);
      },
    );
  });

  it('serializes compactly, since indentation is tokens nobody reads', async () => {
    await withClient([{ json: { chainId: 137, files: page([{ id: 'f1' }]) } }], async (call) => {
      const result = await call('list_files', { vaultAddress: VAULT });
      expect(textOf(result)).not.toMatch(/\n\s+"/);
    });
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

  /**
   * The path an upload reads can be chosen by the model, and the model reads documents other people
   * wrote. This asserts the refusal happens before the file ever reaches the wire.
   */
  it('refuses to upload from outside the allowed roots, without calling the API', async () => {
    const allowed = await mkdtemp(path.join(tmpdir(), 'rootkey-allowed-'));
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'rootkey-elsewhere-'));
    const filePath = path.join(elsewhere, 'secret.txt');
    await writeFile(filePath, 'x');

    await withClient(
      [{ json: {} }],
      async (call, stub) => {
        const result = await call('upload_file', { filePath, vaultAddress: VAULT });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('ROOTKEY_ALLOWED_DIRS');
        expect(stub.calls).toHaveLength(0);
      },
      testConfig({ allowedRoots: [allowed] }),
    );
  });

  it('refuses to upload from a hidden directory inside an allowed root', async () => {
    const allowed = await mkdtemp(path.join(tmpdir(), 'rootkey-allowed-'));
    const hidden = path.join(allowed, '.ssh');
    await mkdir(hidden);
    const filePath = path.join(hidden, 'id_rsa');
    await writeFile(filePath, 'x');

    await withClient(
      [{ json: {} }],
      async (call, stub) => {
        const result = await call('validate_file', { fileId: 'f1', filePath, vaultAddress: VAULT });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('hidden directory');
        expect(stub.calls).toHaveLength(0);
      },
      testConfig({ allowedRoots: [allowed] }),
    );
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

  // `method` is required by the endpoint but the API ignores it and always performs a SHA-256 hash
  // comparison, so it is sent as a constant rather than exposed as a choice the model has to make.
  it('always sends method=hash and does not accept a method argument', async () => {
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

        const rejected = await call('validate_file', {
          fileId: 'f1',
          filePath,
          vaultAddress: VAULT,
          method: 'signature',
        });
        expect(rejected.isError).toBe(true);
        expect(textOf(rejected)).toContain('method');
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

describe('wait_for_recovery_point', () => {
  it('polls until the archive reaches a terminal state and reports it is downloadable', async () => {
    await withClient(
      [
        { json: { recoveryPoint: { id: 'rp1', status: 'processing', progress: 40 } } },
        { json: { recoveryPoint: { id: 'rp1', status: 'completed', progress: 100 } } },
      ],
      async (call, stub) => {
        const result = await call('wait_for_recovery_point', {
          recoveryPointId: 'rp1',
          pollIntervalSeconds: 1,
          timeoutSeconds: 30,
        });

        expect(stub.calls.length).toBeGreaterThanOrEqual(2);
        const payload = payloadOf(result) as { status: string; timedOut: boolean };
        expect(payload.status).toBe('completed');
        expect(payload.timedOut).toBe(false);
        expect(textOf(result)).toContain('download_recovery_point');
      },
    );
  });

  it('stops on a failed archive rather than waiting out the timeout', async () => {
    await withClient([{ json: { recoveryPoint: { id: 'rp1', status: 'failed' } } }], async (call, stub) => {
      const result = await call('wait_for_recovery_point', { recoveryPointId: 'rp1', timeoutSeconds: 300 });

      expect(stub.calls).toHaveLength(1);
      expect((payloadOf(result) as { timedOut: boolean }).timedOut).toBe(false);
      expect(textOf(result)).toContain('cannot be downloaded');
    });
  });

  // Timing out is a normal outcome, not an error: the archive is fine, the wait simply ran out.
  it('returns timedOut rather than an error when the archive is still building', async () => {
    await withClient([{ json: { recoveryPoint: { id: 'rp1', status: 'processing' } } }], async (call) => {
      const result = await call('wait_for_recovery_point', {
        recoveryPointId: 'rp1',
        timeoutSeconds: 5,
        pollIntervalSeconds: 60,
      });

      expect(result.isError).toBeFalsy();
      const payload = payloadOf(result) as { timedOut: boolean; status: string };
      expect(payload.timedOut).toBe(true);
      expect(payload.status).toBe('processing');
      expect(textOf(result)).toContain('call wait_for_recovery_point again');
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

describe('progress', () => {
  it('reports download progress when the client sends a progressToken', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rootkey-dl-'));
    const seen: Array<{ progress: number; total?: number; message?: string }> = [];

    const stub = stubFetch([{ text: 'twelve-bytes', headers: { 'content-length': '12' } }]);
    const { client, close } = await connectTestClient();
    client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      seen.push(notification.params);
    });

    try {
      await client.callTool({
        name: 'download_file',
        arguments: { fileId: 'f1', outputPath: dir },
        _meta: { progressToken: 'tok-1' },
      });

      expect(stub.calls).toHaveLength(1);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.at(-1)?.progress).toBe(12);
      expect(seen.at(-1)?.total).toBe(12);
      expect(seen.at(-1)?.message).toBe('Downloading');
    } finally {
      await close();
    }
  });

  it('reports the upload phases, since fetch cannot observe the bytes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rootkey-upload-'));
    const filePath = path.join(dir, 'a.txt');
    await writeFile(filePath, 'x');
    const messages: string[] = [];

    stubFetch([
      { json: { chainId: 137, transactionHash: '0xhash' } },
      { json: { chainId: 137, files: page([]) } },
    ]);
    const { client, close } = await connectTestClient();
    client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      messages.push(String(notification.params.message));
    });

    try {
      await client.callTool({
        name: 'upload_file',
        arguments: { filePath, vaultAddress: VAULT },
        _meta: { progressToken: 'tok-2' },
      });

      expect(messages[0]).toContain('Uploading');
      expect(messages).toContain('Done');
    } finally {
      await close();
    }
  });

  // Silence is the correct behaviour when nobody asked: progress is opt-in per the spec.
  it('sends nothing when the client did not ask for progress', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rootkey-dl-'));
    const seen: unknown[] = [];

    stubFetch([{ text: 'bytes', headers: { 'content-length': '5' } }]);
    const { client, close } = await connectTestClient();
    client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      seen.push(notification);
    });

    try {
      await client.callTool({ name: 'download_file', arguments: { fileId: 'f1', outputPath: dir } });
      expect(seen).toHaveLength(0);
    } finally {
      await close();
    }
  });
});

describe('resource links', () => {
  it('returns the saved file as a resource_link, not only as a path in JSON', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rootkey-dl-'));

    await withClient([{ text: 'file-bytes' }], async (call) => {
      const result = await call('download_file', { fileId: 'f1', outputPath: dir });

      const link = result.content.find((part) => part.type === 'resource_link') as
        | { type: 'resource_link'; uri: string; name: string; description: string }
        | undefined;

      expect(link).toBeDefined();
      expect(link?.uri.startsWith('file://')).toBe(true);
      expect(decodeURIComponent(link!.uri)).toContain(link!.name);
      expect(link?.description).toContain('f1');

      // The JSON payload is still the last text block, so existing consumers are unaffected.
      expect((payloadOf(result) as { savedPath: string }).savedPath).toContain(dir);
    });
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
      expect(payload.registeredTools).toBe(27);
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
