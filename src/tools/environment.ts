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
      name: 'get_environment_info',
      title: 'Get server environment info',
      description:
        'Report how this ROOTKey MCP server is configured: version, API base URL, environment, whether the ' +
        'configured key is a live or test key, read-only mode and the number of registered tools. Makes no ' +
        'API call and never reveals the API key.',
      readOnly: true,
      local: true,
      idempotent: true,
      inputSchema: {},
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
