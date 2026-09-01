import { z } from 'zod';
import { ToolInputError } from '../errors.js';
import type { CreateVaultResponse } from '../types.js';
import { optionalString, requireString, vaultAddressArg, type ToolDefinition } from './shared.js';

export const vaultTools: ToolDefinition[] = [
  {
    name: 'rootkey_create_vault',
    title: 'Create vault',
    description:
      'Create a vault (or table) to hold files or records. Returns the new vault address, which every ' +
      'other vault-scoped tool needs, so relay it to the user.',
    inputSchema: {
      vaultName: z.string().min(1).describe('Name of the new vault.'),
      description: z.string().optional().describe('Optional description.'),
      teamId: z.string().uuid().optional().describe("Team UUID. Defaults to the organisation's default team."),
    },
    handler: async (args, ctx, extra) => {
      const data = await ctx.client.request<CreateVaultResponse>({
        method: 'POST',
        path: 'platform/vaults',
        body: {
          vaultName: requireString(args, 'vaultName'),
          description: optionalString(args, 'description'),
          teamId: optionalString(args, 'teamId'),
        },
        signal: extra.signal,
      });

      return {
        notice: data?.address
          ? `Vault created at address ${data.address}. Save it: the API has no endpoint that lists vaults.`
          : undefined,
        data,
      };
    },
  },

  {
    name: 'rootkey_update_vault',
    title: 'Update vault',
    description: 'Rename a vault or change its description. Pass at least one of name or description.',
    idempotent: true,
    inputSchema: {
      vaultAddress: vaultAddressArg,
      name: z.string().optional().describe('New vault name.'),
      description: z.string().optional().describe('New description.'),
    },
    handler: async (args, ctx, extra) => {
      const name = optionalString(args, 'name');
      const description = optionalString(args, 'description');
      if (name === undefined && description === undefined) {
        throw new ToolInputError('Pass at least one of "name" or "description" to update.');
      }

      const data = await ctx.client.request({
        method: 'PUT',
        path: `platform/vaults/${encodeURIComponent(requireString(args, 'vaultAddress'))}`,
        body: { name, description },
        signal: extra.signal,
      });

      return { data };
    },
  },

  {
    name: 'rootkey_delete_vault',
    title: 'Delete vault',
    description:
      'Delete a vault and everything inside it. The vault and its files move to the trash: they stop appearing ' +
      'in every list tool immediately, and stay recoverable from the Restore Center in the ROOTKey dashboard ' +
      'until the retention policy purges them for good. Confirm with the user before calling it.',
    destructive: true,
    idempotent: true,
    inputSchema: {
      vaultAddress: vaultAddressArg,
    },
    handler: async (args, ctx, extra) => {
      const vaultAddress = requireString(args, 'vaultAddress');
      await ctx.client.request({
        method: 'DELETE',
        path: `platform/vaults/${encodeURIComponent(vaultAddress)}`,
        signal: extra.signal,
      });

      // The endpoint answers 200 with an empty body, so we synthesise a result.
      return { data: { deleted: true, vaultAddress } };
    },
  },
];
