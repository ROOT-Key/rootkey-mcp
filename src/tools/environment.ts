import { z } from 'zod';
import { keyMode, type Config } from '../config.js';
import { ApiError, describeApiError } from '../errors.js';
import { SERVER_VERSION } from '../version.js';
import type { ToolDefinition } from './shared.js';

/** What `GET /me` answers for a personal access token: identity only, nothing about any organization. */
interface MeResponse {
  user?: { id?: string; name?: string; email?: string; [key: string]: unknown };
  credential?: {
    id?: string;
    type?: string;
    name?: string;
    scopes?: string[];
    allOrganizations?: boolean;
    organizationIds?: string[];
    expiresAt?: string | null;
    [key: string]: unknown;
  };
}

/** What `GET /organization` answers: the organization the request is pinned to, and what the token may do there. */
interface OrganizationResponse {
  id?: string;
  name?: string;
  mode?: string;
  effectiveScopes?: string[];
  [key: string]: unknown;
}

/**
 * Only the documented fields are relayed. The tool promises never to reveal the credential, and a backend that
 * later adds a field to these objects (a hash, an internal id) must not turn that promise false by accident.
 */
function pick(source: unknown, keys: string[]): Record<string, unknown> | null {
  if (typeof source !== 'object' || source === null) return null;
  const record = source as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, record[key]]));
}

const USER_FIELDS = ['id', 'name', 'email'];
const CREDENTIAL_FIELDS = ['id', 'type', 'name', 'scopes', 'allOrganizations', 'organizationIds', 'expiresAt'];
const ORGANIZATION_FIELDS = ['id', 'name', 'mode', 'effectiveScopes'];

/**
 * Diagnostics. With an organization API key it answers from configuration alone, without a network call
 * and without exposing a character of the key. With a personal access token it asks the API who the token
 * belongs to and what it can do in the selected organization - the API is the only one who knows, and
 * guessing from the token text would be the old keyMode mistake again.
 */
export function environmentTools(toolCount: () => number, config: Config): ToolDefinition[] {
  return [
    {
      name: 'rootkey_get_environment_info',
      title: 'Get server environment info',
      description:
        'Report how this ROOTKey MCP server is configured: version, API base URL, environment, read-only mode and the ' +
        'number of registered tools. With a personal access token it also asks the API who you are and what the ' +
        'token may do: the user, the token name, its scopes and expiry, and for the selected organization its agent ' +
        'policy mode and the scopes that are effective there (the token scopes narrowed by that policy). ' +
        'With an organization API key (deprecated) it makes no API call and reports the key mode when the key prefix ' +
        'reveals it. Never reveals the credential.',
      readOnly: true,
      // Local only while no personal access token is in play: a token is introspected over the wire.
      local: (cfg) => cfg.credential.kind === 'api_key',
      organization: 'optional',
      idempotent: true,
      inputSchema: {},
      outputSchema: z
        .object({
          serverVersion: z.string(),
          baseUrl: z.string(),
          environment: z.enum(['production', 'custom']),
          credentialType: z.enum(['personal_access_token', 'organization_api_key']),
          keyMode: z
            .enum(['live', 'test', 'unknown'])
            .optional()
            .describe(
              "Organization API keys only. 'live' or 'test' only when the key carries an rk_live_ or rk_test_ prefix; 'unknown' otherwise (existing keys are plain UUIDs, so unknown does not mean invalid). The key itself is never exposed.",
            ),
          dataMode: z
            .enum(['live', 'test'])
            .optional()
            .describe(
              'Personal access tokens only: which data set this server asks for. It follows ROOTKEY_TEST_MODE and is live when that is unset.',
            ),
          user: z.unknown().optional().describe('Personal access tokens only: the account the token belongs to.'),
          credential: z
            .unknown()
            .optional()
            .describe('Personal access tokens only: the token name, scopes, expiry and the organizations it covers.'),
          organization: z
            .unknown()
            .optional()
            .describe(
              'Personal access tokens only: the selected organization with its agent policy mode and effective scopes, or null when none is selected or the API refused it (see organizationError).',
            ),
          organizationError: z.string().optional(),
          readOnlyMode: z.boolean(),
          registeredTools: z.number(),
        })
        .passthrough(),
      handler: async (_args, ctx, extra) => {
        const base = {
          serverVersion: SERVER_VERSION,
          baseUrl: ctx.config.baseUrl,
          environment: ctx.config.environment,
          readOnlyMode: ctx.config.readOnly,
          registeredTools: toolCount(),
        };

        if (ctx.config.credential.kind === 'api_key') {
          return {
            data: { ...base, credentialType: 'organization_api_key', keyMode: keyMode(ctx.config.credential.apiKey) },
          };
        }

        // A failure here is the answer to "is my token working?", so it is a tool error, not a blank.
        const me = await ctx.client.forOrganization(undefined).request<MeResponse>({
          method: 'GET',
          path: 'me',
          signal: extra.signal,
        });

        let organization: OrganizationResponse | null = null;
        let organizationError: string | undefined;
        if (ctx.organization !== undefined) {
          try {
            organization = (await ctx.client.request<OrganizationResponse>({
              method: 'GET',
              path: 'organization',
              signal: extra.signal,
            })) ?? null;
          } catch (error) {
            // The policy refusals are exactly what this tool is asked about: report them, do not hide the identity.
            if (!(error instanceof ApiError)) throw error;
            organizationError = describeApiError(error, ctx.config.credential.kind);
          }
        }

        return {
          notice:
            ctx.organization === undefined
              ? 'No organization is selected. Call rootkey_list_organizations and ask the user which one to use, then ' +
                'pass it as "organization" (or set ROOTKEY_ORGANIZATION).'
              : undefined,
          data: {
            ...base,
            credentialType: 'personal_access_token',
            dataMode: ctx.config.testMode === true ? 'test' : 'live',
            user: pick(me?.user, USER_FIELDS),
            credential: pick(me?.credential, CREDENTIAL_FIELDS),
            organization: pick(organization, ORGANIZATION_FIELDS),
            ...(organizationError === undefined ? {} : { organizationError }),
          },
        };
      },
    },
  ];
}
