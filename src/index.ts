import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig } from './config.js';
import { redactSecrets, registerSecret } from './errors.js';
import { log, setLogLevel } from './log.js';
import { buildServer } from './server.js';
import { SERVER_VERSION } from './version.js';

async function main(): Promise<void> {
  const config = loadConfig();
  registerSecret(config.credential.kind === 'pat' ? config.credential.token : config.credential.apiKey);
  setLogLevel(config.logLevel);
  for (const warning of config.warnings) log.warn(warning);

  const { server, toolNames, promptNames } = buildServer(config);

  await server.connect(new StdioServerTransport());

  log.info(
    `rootkey-mcp ${SERVER_VERSION} ready on stdio - ${toolNames.length} tools, ${promptNames.length} prompts, ` +
      `${config.environment} API at ${config.baseUrl}, ` +
      `${config.credential.kind === 'pat' ? 'personal access token' : 'organization API key'}` +
      `${config.readOnly ? ', read-only mode' : ''}`,
  );
}

main().catch((error: unknown) => {
  // Fail loudly on stderr and exit non-zero: MCP clients surface this in their server logs.
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  if (error instanceof ConfigError) {
    process.stderr.write(`[rootkey-mcp] configuration error: ${message}\n`);
  } else {
    process.stderr.write(`[rootkey-mcp] fatal: ${message}\n`);
  }
  process.exit(1);
});
