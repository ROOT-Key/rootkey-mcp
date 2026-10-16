import { z } from 'zod';
import { normalizePage } from '../normalize.js';
import type { OrganizationSummary } from '../types.js';
import {
  THIRD_PARTY_TEXT_NOTICE,
  pageOutputSchema,
  pagedQuery,
  paginationArgs,
  sanitizeRows,
  type ToolDefinition,
} from './shared.js';

/** An organization that is listed but will refuse the next call: DISABLED, or this user is blocked in it. */
function refusesAgents(row: OrganizationSummary): boolean {
  return row?.blocked === true || row?.mode === 'DISABLED';
}

export const organizationTools: ToolDefinition[] = [
  {
    name: 'rootkey_list_organizations',
    title: 'List organizations',
    description:
      'List the organizations this personal access token can act in. Each row has the organization id (the value ' +
      'every other tool takes as "organization"), its name, its agent policy mode (DISABLED, READ_ONLY or FULL) and ' +
      'whether you are blocked from agent access in it. Organizations that refuse agents are listed too, so the ' +
      'reason is visible. Call this when you do not know which organization to use, and ask the user to choose ' +
      'when there is more than one.',
    readOnly: true,
    organization: 'none',
    credential: 'pat',
    inputSchema: {
      cursor: paginationArgs.cursor,
      limit: paginationArgs.limit,
    },
    outputSchema: pageOutputSchema,
    handler: async (args, ctx, extra) => {
      const { cursor, limit } = pagedQuery(args);
      const payload = await ctx.client.request({
        method: 'GET',
        path: 'organizations',
        query: { cursor, limit },
        signal: extra.signal,
      });
      const page = normalizePage(payload);
      page.items = sanitizeRows(page.items);

      const refusing = (page.items as OrganizationSummary[]).filter(refusesAgents).length;
      return {
        notice: [
          refusing > 0
            ? `${refusing} organization(s) on this page currently refuse agent access (mode DISABLED, or blocked true). ` +
              'They are listed so the reason is visible; an admin of that organization changes it under ' +
              'Settings -> AI agents. Do not try to work around it.'
            : undefined,
          THIRD_PARTY_TEXT_NOTICE,
        ]
          .filter(Boolean)
          .join('\n'),
        data: page,
      };
    },
  },
];
