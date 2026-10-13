import { z } from 'zod';
import { keyMode } from '../config.js';
import { SERVER_VERSION } from '../version.js';
import type { ToolDefinition } from './shared.js';

/**
 * Local diagnostics. Answers "which environment and which kind of key am I on?" without a network
 * call, and without exposing a single character of the key.
 */
export function environmentTools(toolCount: () => number): ToolDefinition[] {
  return [
    {
      name: 'rootkey_get_environment_info',
      title: 'Get server environment info',
      description:
        'Report how this ROOTKey MCP server is configured: version, API base URL, environment, the key mode ' +
        'when the key prefix reveals it, read-only mode and the number of registered tools. Makes no ' +
        'API call and never reveals the API key.',
      readOnly: true,
      local: true,
      idempotent: true,
      inputSchema: {},
      outputSchema: z.object({
        serverVersion: z.string(),
        baseUrl: z.string(),
        environment: z.enum(['production', 'custom']),
        keyMode: z.enum(['live', 'test', 'unknown']).describe("'live' or 'test' only when the key carries an rk_live_ or rk_test_ prefix; 'unknown' otherwise (existing keys are plain UUIDs, so unknown does not mean invalid). The key itself is never exposed."),
        readOnlyMode: z.boolean(),
        registeredTools: z.number(),
      }),
      handler: async (_args, ctx) => ({
        data: {
          serverVersion: SERVER_VERSION,
          baseUrl: ctx.config.baseUrl,
          environment: ctx.config.environment,
          keyMode: keyMode(ctx.config.apiKey),
          readOnlyMode: ctx.config.readOnly,
          registeredTools: toolCount(),
        },
      }),
    },
  ];
}
