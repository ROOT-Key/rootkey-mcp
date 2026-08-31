import { z } from 'zod';
import { saveResponseToFile } from '../download.js';
import { log } from '../log.js';
import { normalizePage } from '../normalize.js';
import type { CreateSmartContractResponse, FileSummary } from '../types.js';
import {
  buildFileForm,
  isoDateTime,
  optionalString,
  pageOutputSchema,
  pagedQuery,
  paginationArgs,
  readOnlyWriteRoot,
  requireString,
  savedFileOutputSchema,
  statusFilter,
  vaultAddressArg,
  type ToolContext,
  type ToolDefinition,
} from './shared.js';

const fileIdArg = z.string().min(1).describe('File id, as returned by list_files.');

/** Absent on the row means "cannot tell", which must not disqualify an otherwise exact match. */
function sizeMatches(item: FileSummary, sizeBytes: number): boolean {
  const reported = item.sizeBytes;
  if (reported === undefined || reported === null) return true;
  return Number(reported) === sizeBytes;
}

/**
 * Upload endpoints answer with a transaction hash but no file id, so the created file is looked up
 * afterwards. The lookup is best effort: never let it turn a successful upload into a failed tool call.
 *
 * The API's `name` filter is a case-insensitive `contains`, so a row coming back is not evidence that
 * it is the row we just wrote. The identity we return flows straight into get_file and delete_file, so
 * a near-miss is worse than no answer: match the exact name AND the exact byte count, newest first,
 * and return null rather than a plausible-looking neighbour.
 */
async function findUploadedFile(
  ctx: ToolContext,
  path: string,
  vaultAddress: string,
  fileName: string,
  sizeBytes: number,
  signal: AbortSignal | undefined,
): Promise<FileSummary | null> {
  try {
    const payload = await ctx.client.request({
      method: 'GET',
      path,
      query: { vaultAddress, limit: 10, order: 'desc', name: fileName },
      signal,
    });
    const items = normalizePage(payload).items as FileSummary[];
    return items.find((item) => item?.name === fileName && sizeMatches(item, sizeBytes)) ?? null;
  } catch (error) {
    log.debug(`post-upload lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export const fileTools: ToolDefinition[] = [
  {
    name: 'list_files',
    title: 'List files',
    description:
      'List files in a vault, newest first. Supports filtering by name, creation window and anchoring status, ' +
      'and returns aggregate vault counts (registered, pending, error, total size, last 24h) in metadata.',
    readOnly: true,
    inputSchema: {
      vaultAddress: vaultAddressArg,
      name: z.string().optional().describe('Filter by file name.'),
      startDate: isoDateTime.optional().describe('Only files created at or after this timestamp.'),
      endDate: isoDateTime.optional().describe('Only files created at or before this timestamp.'),
      status: statusFilter.optional(),
      ...paginationArgs,
    },
    outputSchema: pageOutputSchema,
    handler: async (args, ctx, extra) => {
      const payload = await ctx.client.request({
        method: 'GET',
        path: 'platform/files',
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
    name: 'upload_file',
    title: 'Upload and anchor a file',
    description:
      'Upload a file from the local machine running this server into a vault and anchor it. Anchoring is ' +
      'asynchronous: the file starts PENDING and becomes REGISTERED or FAILED. Returns the transaction hash ' +
      'and, when the follow-up lookup succeeds, the created file record.',
    inputSchema: {
      filePath: z
        .string()
        .min(1)
        .describe(
          'Absolute path to the file on the machine running this server. Reads are confined to the home ' +
            'directory, the temp directory and the server working directory, and hidden directories inside ' +
            'them are refused; ROOTKEY_ALLOWED_DIRS overrides that list.',
        ),
      vaultAddress: vaultAddressArg,
      fileName: z.string().optional().describe('Name to register. Defaults to the file name on disk.'),
      expirationDate: isoDateTime.optional().describe('Optional expiration timestamp for the anchor.'),
    },
    handler: async (args, ctx, extra) => {
      const vaultAddress = requireString(args, 'vaultAddress');
      const { form, fileName, sizeBytes } = await buildFileForm(
        requireString(args, 'filePath'),
        {
          ownerVault: vaultAddress,
          fileName: optionalString(args, 'fileName'),
          expirationDate: optionalString(args, 'expirationDate'),
        },
        ctx.config.allowedRoots,
      );

      const receipt = await ctx.client.request<CreateSmartContractResponse>({
        method: 'POST',
        path: 'platform/files',
        form,
        signal: extra.signal,
      });

      const file = await findUploadedFile(ctx, 'platform/files', vaultAddress, fileName, sizeBytes, extra.signal);

      return {
        notice: file
          ? undefined
          : 'The upload succeeded. The follow-up lookup could not yet identify the new file with certainty, ' +
            'so no id is reported rather than a guess - call list_files on this vault in a moment to get it.',
        data: { ...receipt, fileName, sizeBytes, file },
      };
    },
  },

  {
    name: 'get_file',
    title: 'Get file details',
    description:
      'Fetch one file with its full detail: hashes, transaction hash, contract address, expiration and ' +
      'usage metrics (downloads, shares, versions, validations, unique users and IPs).',
    readOnly: true,
    inputSchema: {
      fileId: fileIdArg,
      vaultAddress: vaultAddressArg,
    },
    handler: async (args, ctx, extra) => {
      const data = await ctx.client.request({
        method: 'GET',
        path: `platform/files/${encodeURIComponent(requireString(args, 'fileId'))}`,
        query: { ownerVault: requireString(args, 'vaultAddress') },
        signal: extra.signal,
      });
      return { data };
    },
  },

  {
    name: 'download_file',
    title: 'Download a file',
    description:
      'Download a file to the local disk of the machine running this server and return the saved path. ' +
      'File contents are never inlined into the conversation. An existing file is never overwritten. ' +
      'In read-only mode the file must land in the configured download directory.',
    readOnly: true,
    writesLocalFiles: true,
    inputSchema: {
      fileId: fileIdArg,
      outputPath: z
        .string()
        .optional()
        .describe('Target file path or an existing directory. Defaults to ROOTKEY_DOWNLOAD_DIR, then ~/Downloads.'),
    },
    outputSchema: savedFileOutputSchema,
    handler: async (args, ctx, extra) => {
      const fileId = requireString(args, 'fileId');
      const response = await ctx.client.requestBinary({
        method: 'GET',
        path: `platform/files/${encodeURIComponent(fileId)}/download`,
        signal: extra.signal,
      });

      const saved = await saveResponseToFile(response, {
        outputPath: optionalString(args, 'outputPath'),
        downloadDir: ctx.config.downloadDir,
        fallbackName: `rootkey-file-${fileId}`,
        confineTo: await readOnlyWriteRoot(ctx),
      });

      return {
        data: saved,
        links: [{ path: saved.savedPath, description: `Downloaded from ROOTKey file ${fileId}.` }],
      };
    },
  },

  {
    name: 'delete_file',
    title: 'Delete a file',
    description:
      'Delete a file. It moves to the trash: it stops appearing in list_files immediately, and stays ' +
      'recoverable from the Restore Center in the ROOTKey dashboard until the retention policy purges it ' +
      'for good. Confirm with the user first. The on-chain anchor is untouched either way - a proof that ' +
      'was written stays valid forever.',
    destructive: true,
    idempotent: true,
    inputSchema: {
      fileId: fileIdArg,
      vaultAddress: vaultAddressArg,
    },
    handler: async (args, ctx, extra) => {
      const data = await ctx.client.request({
        method: 'DELETE',
        path: `platform/files/${encodeURIComponent(requireString(args, 'fileId'))}`,
        query: { ownerAddress: requireString(args, 'vaultAddress') },
        signal: extra.signal,
      });
      return { data };
    },
  },

  {
    name: 'list_file_versions',
    title: 'List file versions',
    description: 'List every version of a file, newest first.',
    readOnly: true,
    inputSchema: {
      parentId: z.string().min(1).describe('Id of the root file whose versions you want.'),
      vaultAddress: vaultAddressArg,
      ...paginationArgs,
    },
    outputSchema: pageOutputSchema,
    handler: async (args, ctx, extra) => {
      const payload = await ctx.client.request({
        method: 'GET',
        path: `platform/files/${encodeURIComponent(requireString(args, 'parentId'))}/versions`,
        query: { vaultAddress: requireString(args, 'vaultAddress'), ...pagedQuery(args) },
        signal: extra.signal,
      });
      return { data: normalizePage(payload) };
    },
  },

  {
    name: 'upload_file_version',
    title: 'Upload a new file version',
    description:
      'Upload a new version of an existing file from local disk and anchor it. The previous version stays ' +
      'independently verifiable.',
    inputSchema: {
      parentId: z.string().min(1).describe('Id of the file to add a version to.'),
      filePath: z.string().min(1).describe('Absolute path to the new version on the machine running this server.'),
      vaultAddress: vaultAddressArg,
      fileName: z.string().optional().describe('Name to register. Defaults to the file name on disk.'),
      expirationDate: isoDateTime.optional(),
    },
    handler: async (args, ctx, extra) => {
      const parentId = requireString(args, 'parentId');
      const vaultAddress = requireString(args, 'vaultAddress');
      const { form, fileName, sizeBytes } = await buildFileForm(
        requireString(args, 'filePath'),
        {
          ownerVault: vaultAddress,
          fileName: optionalString(args, 'fileName'),
          expirationDate: optionalString(args, 'expirationDate'),
        },
        ctx.config.allowedRoots,
      );

      const versionsPath = `platform/files/${encodeURIComponent(parentId)}/versions`;
      const receipt = await ctx.client.request<CreateSmartContractResponse>({
        method: 'POST',
        path: versionsPath,
        form,
        signal: extra.signal,
      });

      const version = await findUploadedFile(ctx, versionsPath, vaultAddress, fileName, sizeBytes, extra.signal);

      return {
        notice: version
          ? undefined
          : 'The version was uploaded. The follow-up lookup could not yet identify it with certainty, so no ' +
            'id is reported rather than a guess - call list_file_versions shortly to get it.',
        data: { ...receipt, fileName, sizeBytes, version },
      };
    },
  },

  {
    name: 'validate_file',
    title: 'Validate a file against its anchor',
    description:
      'Check a local copy of a file against what was anchored, by comparing SHA-256 hashes. Returns ' +
      'ownership, integrity and validity verdicts. Each call is recorded in the validation history and ' +
      'consumes plan quota, so it is not a read.',
    inputSchema: {
      fileId: fileIdArg,
      filePath: z.string().min(1).describe('Absolute path to the local copy to verify.'),
      vaultAddress: vaultAddressArg,
    },
    handler: async (args, ctx, extra) => {
      const { form } = await buildFileForm(
        requireString(args, 'filePath'),
        {
          ownerVault: requireString(args, 'vaultAddress'),
          // Required by the endpoint, but the API branches on nothing and always answers
          // "SHA-256 Hash Comparison". Sent as a constant rather than offered as a choice.
          method: 'hash',
        },
        ctx.config.allowedRoots,
      );

      const data = await ctx.client.request({
        method: 'POST',
        path: `platform/files/${encodeURIComponent(requireString(args, 'fileId'))}/validate`,
        form,
        signal: extra.signal,
      });
      return { data };
    },
  },

  {
    name: 'get_file_history',
    title: 'Get file activity history',
    description:
      'Read the activity log for a file: who did what and when, including which API key acted. This is the ' +
      'audit trail for compliance evidence.',
    readOnly: true,
    inputSchema: {
      fileId: fileIdArg,
      ...paginationArgs,
    },
    outputSchema: pageOutputSchema,
    handler: async (args, ctx, extra) => {
      const payload = await ctx.client.request({
        method: 'GET',
        path: `platform/files/${encodeURIComponent(requireString(args, 'fileId'))}/history`,
        query: pagedQuery(args),
        signal: extra.signal,
      });
      return { data: normalizePage(payload) };
    },
  },

  {
    name: 'get_file_validations',
    title: 'Get file validation history',
    description: 'List past integrity validations of a file, with the current and previous hashes.',
    readOnly: true,
    inputSchema: {
      fileId: fileIdArg,
      ...paginationArgs,
    },
    outputSchema: pageOutputSchema,
    handler: async (args, ctx, extra) => {
      const payload = await ctx.client.request({
        method: 'GET',
        path: `platform/files/${encodeURIComponent(requireString(args, 'fileId'))}/validations`,
        query: pagedQuery(args),
        signal: extra.signal,
      });
      return { data: normalizePage(payload) };
    },
  },

  {
    name: 'generate_file_audit_report',
    title: 'Generate a compliance audit report',
    description:
      'Queue a NIS2 or DORA compliance report for a file. The API accepts the job and returns a report id; ' +
      'there is no endpoint to fetch the finished report, so tell the user to collect it in the ROOTKey ' +
      'dashboard. A 403 means the plan does not cover this or its limit is used up.',
    inputSchema: {
      fileId: fileIdArg,
      framework: z.enum(['NIS2', 'DORA']).optional().describe('Compliance framework. Defaults to NIS2.'),
      periodStart: isoDateTime.optional().describe('Start of the reporting period.'),
      periodEnd: isoDateTime.optional().describe('End of the reporting period.'),
    },
    handler: async (args, ctx, extra) => {
      const data = await ctx.client.request({
        method: 'POST',
        path: `platform/files/${encodeURIComponent(requireString(args, 'fileId'))}/audit-report`,
        body: {
          framework: optionalString(args, 'framework'),
          periodStart: optionalString(args, 'periodStart'),
          periodEnd: optionalString(args, 'periodEnd'),
        },
        signal: extra.signal,
      });

      return {
        notice:
          'Report queued. It is generated asynchronously and delivered in the ROOTKey dashboard - the API ' +
          'has no endpoint to download it, so there is nothing further to poll here.',
        data,
      };
    },
  },
];
