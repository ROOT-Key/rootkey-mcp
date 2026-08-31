import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import { RootKeyClient } from './http.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';
import { environmentTools } from './tools/environment.js';
import { fileTools } from './tools/files.js';
import { recordTools } from './tools/records.js';
import { recoveryTools } from './tools/recovery.js';
import { registerTools, type ToolContext } from './tools/shared.js';
import { vaultTools } from './tools/vaults.js';

/**
 * What Claude cannot infer from the tool list alone: the API's missing endpoints, its
 * versioning model, and which actions are irreversible.
 */
export const SERVER_INSTRUCTIONS = [
  'This server operates a real ROOTKey workspace through the ROOTKey REST API. Every call is a live',
  'API request that is visible in the ROOTKey dashboard. File writes are additionally anchored on chain.',
  '',
  'Vaults and addresses',
  '- A vault address looks like 0xdf67... and identifies a vault (for files) or a table (for records).',
  '- The API has NO endpoint that lists vaults, so there is no tool for it. Ask the user for the address,',
  '  or read it from the ROOTKey dashboard. create_vault returns a new address: always relay it to the user.',
  '',
  'Environments',
  '- rk_test_ keys work against the development API and rk_live_ keys against production; the data sets are',
  '  separate. get_environment_info reports which one is configured.',
  '',
  'File anchoring is asynchronous',
  '- New files start as PENDING and become REGISTERED or FAILED. Status filters on list tools are',
  '  lowercase (pending, registered, error) while returned values are uppercase; "error" matches FAILED.',
  '',
  'Records',
  '- Records live in tables and are versioned by primary key: create_record with a payload whose key column',
  '  matches an existing record creates a NEW VERSION of it, not a duplicate. Never call create_record twice',
  '  to "retry" unless a new version is what the user wants. Record ids come from __meta.id. Limit: 1 MB.',
  '- Records are NOT anchored on chain today: they are stored, hashed and audited, and they come back',
  '  REGISTERED straight away. There is no PENDING phase to wait for and no transaction hash to report.',
  '  Never tell the user their records are on a blockchain - that is a compliance claim, and only files',
  '  carry an on-chain anchor.',
  '',
  'Ids after creation',
  '- The upload and create endpoints do not return the id of what they created, so those tools look it up',
  '  afterwards. If the result shows a null file, version or record, the write still succeeded - find it with',
  '  the matching list tool.',
  '',
  'Deletes',
  '- delete_vault, delete_file and delete_record move the item to the trash. It stops appearing in every',
  '  list and fetch tool, and it stays recoverable in the ROOTKey dashboard Restore Center until the',
  '  retention policy purges it, at which point it is gone for good. Deleting a vault also takes its files',
  '  with it. Still confirm with the user first - but if they ask whether a delete can be undone, the honest',
  '  answer is yes, from the dashboard, for as long as retention allows.',
  '- delete_recovery_point is different: it erases the archive itself and cannot be undone by anyone.',
  '- A delete is recorded in the activity log, not written to the chain. A file that was anchored keeps its',
  '  on-chain proof after deletion; the anchor is evidence of the past and is never revoked.',
  '- Uploading a new version is permanent: the previous version stays independently verifiable.',
  '',
  'Recovery points',
  '- create_recovery_point returns a one-time password that is shown exactly once and can never be recovered.',
  '  Surface it to the user immediately and tell them to store it; the archive is useless without it.',
  '- Archives build asynchronously: poll get_recovery_point until status is "completed" before downloading.',
  '',
  'Audit reports',
  '- generate_file_audit_report only queues the job. There is no API endpoint to fetch the finished report,',
  '  so direct the user to the ROOTKey dashboard rather than promising to retrieve it.',
  '',
  'Pagination and files on disk',
  '- Pass the previous result pagination.nextCursor as cursor to page forward; the API default page size is 10.',
  '- Uploads read from, and downloads write to, the local disk of the machine running this server. Downloads',
  '  return the saved path and never inline file contents.',
].join('\n');

export interface BuiltServer {
  server: McpServer;
  toolNames: string[];
}

export function buildServer(config: Config): BuiltServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const ctx: ToolContext = { client: new RootKeyClient(config), config };
  const toolNames: string[] = [];

  toolNames.push(
    ...registerTools(server, ctx, [
      ...vaultTools,
      ...fileTools,
      ...recordTools,
      ...recoveryTools,
      ...environmentTools(() => toolNames.length),
    ]),
  );

  return { server, toolNames };
}
