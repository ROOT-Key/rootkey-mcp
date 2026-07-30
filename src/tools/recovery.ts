import { z } from 'zod';
import { saveResponseToFile } from '../download.js';
import { ToolInputError } from '../errors.js';
import { log } from '../log.js';
import { unwrap } from '../normalize.js';
import type { RecoveryPoint } from '../types.js';
import {
  isoDateTime,
  optionalString,
  requireString,
  type ToolContext,
  type ToolDefinition,
} from './shared.js';

const recoveryPointIdArg = z.string().min(1).describe('Recovery point id, from list_recovery_points.');

/** The create call returns only the password, so the new archive is located by name afterwards. */
async function findCreatedRecoveryPoint(
  ctx: ToolContext,
  name: string,
  signal: AbortSignal | undefined,
): Promise<RecoveryPoint | null> {
  try {
    const payload = await ctx.client.request({
      method: 'GET',
      path: 'platform/recovery-point',
      signal,
    });
    const list = unwrap(payload, 'recoveryPoints');
    if (!Array.isArray(list)) return null;
    const matches = (list as RecoveryPoint[]).filter((point) => point?.name === name);
    if (matches.length === 0) return null;
    return (
      matches.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0] ?? null
    );
  } catch (error) {
    log.debug(`post-create recovery point lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export const recoveryTools: ToolDefinition[] = [
  {
    name: 'list_recovery_points',
    title: 'List recovery points',
    description: 'List every recovery point (encrypted backup archive) in the workspace. This endpoint is not paginated.',
    readOnly: true,
    inputSchema: {},
    handler: async (_args, ctx, extra) => {
      const payload = await ctx.client.request({
        method: 'GET',
        path: 'platform/recovery-point',
        signal: extra.signal,
      });
      return { data: { items: unwrap(payload, 'recoveryPoints') } };
    },
  },

  {
    name: 'create_recovery_point',
    title: 'Create a recovery point',
    description:
      'Start building an encrypted backup archive of vault contents, either the whole workspace (global) or ' +
      'named vaults (partial). The API returns a one-time decryption password that can never be retrieved ' +
      'again - show it to the user immediately and tell them to store it. The archive builds asynchronously: ' +
      'poll get_recovery_point until status is completed before downloading.',
    inputSchema: {
      name: z.string().min(1).describe('Name for the recovery point.'),
      scope: z.enum(['global', 'partial']).describe('"global" covers everything; "partial" covers the listed vaults.'),
      vaults: z.array(z.string()).optional().describe('Vault addresses to include. Required when scope is "partial".'),
      timeRangeStart: isoDateTime.optional().describe('Only include content created at or after this timestamp.'),
      timeRangeEnd: isoDateTime.optional().describe('Only include content created at or before this timestamp.'),
    },
    handler: async (args, ctx, extra) => {
      const name = requireString(args, 'name');
      const scope = requireString(args, 'scope');
      const vaults = Array.isArray(args.vaults) ? (args.vaults as string[]).filter((v) => v && v.trim() !== '') : [];

      if (scope === 'partial' && vaults.length === 0) {
        throw new ToolInputError('scope "partial" requires at least one vault address in "vaults".');
      }

      const start = optionalString(args, 'timeRangeStart');
      const end = optionalString(args, 'timeRangeEnd');

      const body: Record<string, unknown> = { name, scope };
      if (vaults.length > 0) body.vaults = vaults;
      if (start || end) body.timeRange = { start, end };

      const created = await ctx.client.request<{ password?: string }>({
        method: 'POST',
        path: 'platform/recovery-point',
        body,
        // The response contains the one-time password: never log the body.
        sensitive: true,
        signal: extra.signal,
      });

      const recoveryPoint = await findCreatedRecoveryPoint(ctx, name, extra.signal);

      const notice = created?.password
        ? `ONE-TIME PASSWORD - shown once and unrecoverable. Store it now, the archive cannot be decrypted ` +
          `without it:\n\n    ${created.password}\n\nThe archive is still building; poll get_recovery_point ` +
          `until its status is "completed" before calling download_recovery_point.`
        : 'The API did not return a password for this recovery point.';

      return { notice, data: { password: created?.password ?? null, recoveryPoint } };
    },
  },

  {
    name: 'get_recovery_point',
    title: 'Get recovery point status',
    description:
      'Fetch one recovery point to follow its build: status (enqueued, processing, completed, failed), ' +
      'progress percentage, file count, size, integrity and hash.',
    readOnly: true,
    inputSchema: {
      recoveryPointId: recoveryPointIdArg,
    },
    handler: async (args, ctx, extra) => {
      const payload = await ctx.client.request({
        method: 'GET',
        path: `platform/recovery-point/${encodeURIComponent(requireString(args, 'recoveryPointId'))}`,
        signal: extra.signal,
      });
      return { data: unwrap(payload, 'recoveryPoint') };
    },
  },

  {
    name: 'download_recovery_point',
    title: 'Download a recovery point archive',
    description:
      'Download the encrypted archive to the local disk of the machine running this server. Only works once ' +
      'the recovery point reports status "completed". The archive can only be opened with the one-time ' +
      'password issued when it was created.',
    readOnly: true,
    inputSchema: {
      recoveryPointId: recoveryPointIdArg,
      outputPath: z
        .string()
        .optional()
        .describe('Target file path or an existing directory. Defaults to ROOTKEY_DOWNLOAD_DIR, then ~/Downloads.'),
    },
    handler: async (args, ctx, extra) => {
      const id = requireString(args, 'recoveryPointId');
      const response = await ctx.client.requestBinary({
        method: 'GET',
        path: `platform/recovery-point/${encodeURIComponent(id)}/download`,
        signal: extra.signal,
      });

      const saved = await saveResponseToFile(response, {
        outputPath: optionalString(args, 'outputPath'),
        downloadDir: ctx.config.downloadDir,
        fallbackName: `rootkey-recovery-point-${id}.zip`,
      });

      return {
        notice: 'Encrypted archive saved. Decrypting it needs the one-time password from create_recovery_point.',
        data: saved,
      };
    },
  },

  {
    name: 'delete_recovery_point',
    title: 'Delete a recovery point',
    description:
      'Permanently delete a recovery point and its archive. Irreversible - confirm with the user first.',
    destructive: true,
    idempotent: true,
    inputSchema: {
      recoveryPointId: recoveryPointIdArg,
    },
    handler: async (args, ctx, extra) => {
      const recoveryPointId = requireString(args, 'recoveryPointId');
      await ctx.client.request({
        method: 'DELETE',
        path: `platform/recovery-point/${encodeURIComponent(recoveryPointId)}`,
        signal: extra.signal,
      });
      return { data: { deleted: true, recoveryPointId } };
    },
  },
];
