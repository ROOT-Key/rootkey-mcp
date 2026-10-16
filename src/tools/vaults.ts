import { z } from 'zod';
import { ToolInputError } from '../errors.js';
import type { CreateVaultResponse } from '../types.js';
import {
  listAddressable,
  optionalString,
  pageOutputSchema,
  paginationArgs,
  requireString,
  vaultAddressArg,
  type ToolDefinition,
} from './shared.js';

export const vaultTools: ToolDefinition[] = [
  {
    name: 'rootkey_list_vaults',
    title: 'List vaults',
    description:
      'List the vaults (the containers that hold files) you can see in the organization, newest first. Returns each ' +
      'vault address, name, classification and status. With a personal access token you see the vaults of your ' +
      'teams (organization admins see them all); a RESTRICTED vault is listed with agentAccessible false and cannot be read or changed by an ' +
      'agent. Tables, which hold records, come from rootkey_list_tables.',
    readOnly: true,
    inputSchema: { ...paginationArgs },
    outputSchema: pageOutputSchema,
    handler: (args, ctx, extra) => listAddressable(ctx, 'vaults', args, extra.signal),
  },

  {
    name: 'rootkey_create_vault',
    title: 'Create vault',
    description:
      'Create a vault (or table) to hold files or records. Returns the new vault address, which every ' +
      'other vault-scoped tool needs, so relay it to the user.',
    inputSchema: {
      vaultName: z.string().min(1).describe('Name of the new vault.'),
      description: z.string().optional().describe('Optional description.'),
      teamId: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Team UUID. Defaults to the organisation's default team; with a personal access token you must be a member of the team.",
        ),
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
          ? `Vault created at address ${data.address}. Relay it to the user; rootkey_list_vaults finds it again later.`
          : undefined,
        data,
      };
    },
  },

  {
    name: 'rootkey_update_vault',
    title: 'Update vault',
    description:
      'Rename a vault or change its description. Pass at least one of name or description. The previous name or ' +
      'description is overwritten and not kept, so confirm with the user first.',
    // An overwrite, not an addition: the previous value is gone. Repeating the same call changes nothing further,
    // which is what idempotent says; destructive says a client should not run it unasked.
    destructive: true,
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

      const vaultAddress = requireString(args, 'vaultAddress');
      const data = await ctx.client.request({
        method: 'PUT',
        path: `platform/vaults/${encodeURIComponent(vaultAddress)}`,
        body: { name, description },
        signal: extra.signal,
      });

      // Live against the real API: the endpoint answers 200 with an empty body, which a model reads as "null" and
      // may take for a failure. Say what happened, as the delete tools do.
      return { data: data ?? { updated: true, vaultAddress, ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }) } };
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
