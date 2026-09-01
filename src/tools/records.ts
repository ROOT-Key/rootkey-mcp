import { z } from 'zod';
import { ToolInputError } from '../errors.js';
import { log } from '../log.js';
import { normalizePage } from '../normalize.js';
import type { RecordRow } from '../types.js';
import {
  isoDateTime,
  optionalString,
  pageOutputSchema,
  pagedQuery,
  paginationArgs,
  requireString,
  statusFilter,
  vaultAddressArg,
  type ToolContext,
  type ToolDefinition,
} from './shared.js';

const recordIdArg = z
  .string()
  .min(1)
  .describe('Record id, taken from __meta.id in a rootkey_list_records result.');

/** Deep structural comparison, used to spot the row we just wrote among the newest rows. */
function matchesPayload(row: RecordRow, payload: Record<string, unknown>): boolean {
  return Object.entries(payload).every(([key, value]) => {
    const actual = (row as Record<string, unknown>)[key];
    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(actual) === JSON.stringify(value);
    }
    return actual === value;
  });
}

/**
 * `POST /platform/records` answers with `{chainId}` only - no id, no transaction hash. The row is
 * looked up afterwards so the caller gets something addressable. Best effort by design.
 */
async function findCreatedRecord(
  ctx: ToolContext,
  vaultAddress: string,
  payload: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<{ record: RecordRow | null; matched: 'exact' | 'newest' | null }> {
  try {
    const response = await ctx.client.request({
      method: 'GET',
      path: 'platform/records',
      query: { vaultAddress, limit: 10, order: 'desc' },
      signal,
    });
    const rows = normalizePage(response).items as RecordRow[];
    const exact = rows.find((row) => matchesPayload(row, payload));
    if (exact) return { record: exact, matched: 'exact' };
    const newest = rows[0];
    return newest ? { record: newest, matched: 'newest' } : { record: null, matched: null };
  } catch (error) {
    log.debug(`post-create record lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return { record: null, matched: null };
  }
}

export const recordTools: ToolDefinition[] = [
  {
    name: 'rootkey_list_records',
    title: 'List records',
    description:
      'List records in a table, newest first. Each row carries its own columns at the top level plus a ' +
      'reserved __meta object holding the record id, parent id, status and version count.',
    readOnly: true,
    inputSchema: {
      vaultAddress: vaultAddressArg,
      name: z.string().optional().describe('Filter by name.'),
      startDate: isoDateTime.optional(),
      endDate: isoDateTime.optional(),
      status: statusFilter.optional(),
      ...paginationArgs,
    },
    outputSchema: pageOutputSchema,
    handler: async (args, ctx, extra) => {
      const payload = await ctx.client.request({
        method: 'GET',
        path: 'platform/records',
        query: {
          vaultAddress: requireString(args, 'vaultAddress'),
          name: optionalString(args, 'name'),
          startDate: optionalString(args, 'startDate'),
          endDate: optionalString(args, 'endDate'),
          status: optionalString(args, 'status'),
          ...pagedQuery(args),
        },
        signal: extra.signal,
      });
      return { data: normalizePage(payload) };
    },
  },

  {
    name: 'rootkey_create_record',
    title: 'Create a record',
    description:
      'Write a record into a table. Records are versioned by primary key: posting a payload whose key column ' +
      'matches an existing record creates a NEW VERSION of that record rather than a duplicate, so calling ' +
      'this twice is not a no-op. Records are limited to 1 MB. Unlike files, records are NOT anchored on ' +
      'chain: the row is stored, hashed and audited, comes back REGISTERED straight away, and has no ' +
      'transaction hash - do not describe it to the user as being on a blockchain.',
    inputSchema: {
      vaultAddress: vaultAddressArg,
      recordData: z
        .record(z.unknown())
        .describe(
          'The record payload as a flat or nested object. The table primary key column decides whether this ' +
            'creates a new record or a new version of an existing one. Keys starting with __ are reserved.',
        ),
      expirationDate: isoDateTime.optional(),
    },
    handler: async (args, ctx, extra) => {
      const vaultAddress = requireString(args, 'vaultAddress');
      const recordData = args.recordData;
      if (typeof recordData !== 'object' || recordData === null || Array.isArray(recordData)) {
        throw new ToolInputError('"recordData" must be an object of column values.');
      }
      const payload = recordData as Record<string, unknown>;
      if (Object.keys(payload).length === 0) {
        throw new ToolInputError('"recordData" must contain at least one field.');
      }

      const receipt = await ctx.client.request({
        method: 'POST',
        path: 'platform/records',
        body: {
          ownerVault: vaultAddress,
          recordData: payload,
          expirationDate: optionalString(args, 'expirationDate'),
        },
        signal: extra.signal,
      });

      const { record, matched } = await findCreatedRecord(ctx, vaultAddress, payload, extra.signal);

      return {
        notice:
          matched === 'exact'
            ? undefined
            : matched === 'newest'
              ? 'The create call does not return an id. The newest row in the table is shown below as the ' +
                'likely match - confirm it before acting on it.'
              : 'The record was created but the follow-up lookup returned nothing. Use rootkey_list_records to find it.',
        data: { ...(receipt as object), record, matched },
      };
    },
  },

  {
    name: 'rootkey_list_record_versions',
    title: 'List record versions',
    description: 'List every version of a record, newest first.',
    readOnly: true,
    inputSchema: {
      parentId: z.string().min(1).describe('Id of the root record whose versions you want.'),
      vaultAddress: vaultAddressArg,
      ...paginationArgs,
    },
    outputSchema: pageOutputSchema,
    handler: async (args, ctx, extra) => {
      const payload = await ctx.client.request({
        method: 'GET',
        path: `platform/records/${encodeURIComponent(requireString(args, 'parentId'))}/versions`,
        query: { vaultAddress: requireString(args, 'vaultAddress'), ...pagedQuery(args) },
        signal: extra.signal,
      });
      return { data: normalizePage(payload) };
    },
  },

  {
    name: 'rootkey_get_record_history',
    title: 'Get record activity history',
    description: 'Read the activity log for a record - the audit trail of who changed it and when.',
    readOnly: true,
    inputSchema: {
      recordId: recordIdArg,
      ...paginationArgs,
    },
    outputSchema: pageOutputSchema,
    handler: async (args, ctx, extra) => {
      const payload = await ctx.client.request({
        method: 'GET',
        // The spec spells this path parameter {fileId}; it takes a record id.
        path: `platform/records/${encodeURIComponent(requireString(args, 'recordId'))}/history`,
        query: pagedQuery(args),
        signal: extra.signal,
      });
      return { data: normalizePage(payload) };
    },
  },

  {
    name: 'rootkey_get_record_validations',
    title: 'Get record validation history',
    description: 'List past integrity validations of a record, with the current and previous hashes.',
    readOnly: true,
    inputSchema: {
      recordId: recordIdArg,
      ...paginationArgs,
    },
    outputSchema: pageOutputSchema,
    handler: async (args, ctx, extra) => {
      const payload = await ctx.client.request({
        method: 'GET',
        path: `platform/records/${encodeURIComponent(requireString(args, 'recordId'))}/validations`,
        query: pagedQuery(args),
        signal: extra.signal,
      });
      return { data: normalizePage(payload) };
    },
  },

  {
    name: 'rootkey_delete_record',
    title: 'Delete a record',
    description:
      'Delete a record. It moves to the trash: it stops appearing in rootkey_list_records immediately, and stays ' +
      'recoverable from the Restore Center in the ROOTKey dashboard until the retention policy purges it ' +
      'for good. Confirm with the user first.',
    destructive: true,
    idempotent: true,
    inputSchema: {
      recordId: recordIdArg,
      vaultAddress: vaultAddressArg,
    },
    handler: async (args, ctx, extra) => {
      const data = await ctx.client.request({
        method: 'DELETE',
        path: `platform/records/${encodeURIComponent(requireString(args, 'recordId'))}`,
        query: { ownerAddress: requireString(args, 'vaultAddress') },
        signal: extra.signal,
      });
      return { data };
    },
  },
];
