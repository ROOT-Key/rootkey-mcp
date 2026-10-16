#!/usr/bin/env node
/**
 * Live round trip against a real ROOTKey deployment (the public API unless ROOTKEY_API_URL is set),
 * driving the built server exactly as a client does (spawned process, MCP over stdio). Creates a
 * vault, exercises files and records, then deletes everything it made.
 *
 * Guarded on purpose - it writes real data and consumes plan quota:
 *
 *   ROOTKEY_SMOKE=1 ROOTKEY_TOKEN=<a personal access token> ROOTKEY_ORGANIZATION=<org id> ROOTKEY_TEST_MODE=true npm run smoke
 *   ROOTKEY_SMOKE=1 ROOTKEY_API_KEY=<a test key> npm run smoke        (deprecated organization API key)
 *
 * There is no separate public API for testing: the credential decides whether this touches test or live data. A
 * personal access token needs ROOTKEY_ORGANIZATION and ROOTKEY_TEST_MODE=true; an organization API key without an
 * rk_test_ prefix needs ROOTKEY_SMOKE_ALLOW_LIVE=1. Set ROOTKEY_API_URL to run it against a self-hosted deployment.
 *
 * A personal access token must carry rootkey.read, rootkey.write and rootkey.delete and cover that organization,
 * and the organization's agent policy must be FULL: the run writes and then deletes. Recovery points are refused to
 * agents by the API, so under a token the server does not offer them and this script does not touch them.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BUNDLE = fileURLToPath(new URL('../dist/index.js', import.meta.url));

if (process.env.ROOTKEY_SMOKE !== '1') {
  console.error('Refusing to run: set ROOTKEY_SMOKE=1 to confirm you want live API writes.');
  process.exit(2);
}
const usingToken = Boolean(process.env.ROOTKEY_TOKEN);
if (!usingToken && !process.env.ROOTKEY_API_KEY) {
  console.error('Set ROOTKEY_TOKEN (a personal access token) or ROOTKEY_API_KEY (deprecated); the smoke run writes real data.');
  process.exit(2);
}
if (usingToken) {
  // A token reaches every organization it covers, so the run must be told which one it may write in, and
  // whether that is the test data or the live data.
  if (!process.env.ROOTKEY_ORGANIZATION) {
    console.error('Set ROOTKEY_ORGANIZATION: the smoke run will not pick an organization to write in.');
    process.exit(2);
  }
  if (process.env.ROOTKEY_TEST_MODE?.trim().toLowerCase() !== 'true' && process.env.ROOTKEY_SMOKE_ALLOW_LIVE !== '1') {
    console.error(
      'This token would write to live data unless ROOTKEY_TEST_MODE=true, and the smoke run creates and deletes real data. ' +
        'Set ROOTKEY_TEST_MODE=true, or re-run with ROOTKEY_SMOKE_ALLOW_LIVE=1 if live data is what you want.',
    );
    process.exit(2);
  }
} else if (!process.env.ROOTKEY_API_KEY.startsWith('rk_test_') && process.env.ROOTKEY_SMOKE_ALLOW_LIVE !== '1') {
  // Existing keys are plain UUIDs, so the script cannot tell a test key from a live one unless the key
  // carries the rk_test_ prefix. Anything else needs an explicit acknowledgement.
  console.error(
    'Cannot tell from this key whether it works on test or live data, and the smoke run creates and deletes real data. ' +
      'If it is a test key, re-run with ROOTKEY_SMOKE_ALLOW_LIVE=1.',
  );
  process.exit(2);
}

const client = new Client({ name: 'rootkey-smoke', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE],
    env: {
      PATH: process.env.PATH ?? '',
      ...(usingToken
        ? {
            ROOTKEY_TOKEN: process.env.ROOTKEY_TOKEN,
            ROOTKEY_ORGANIZATION: process.env.ROOTKEY_ORGANIZATION,
            ...(process.env.ROOTKEY_TEST_MODE ? { ROOTKEY_TEST_MODE: process.env.ROOTKEY_TEST_MODE } : {}),
          }
        : { ROOTKEY_API_KEY: process.env.ROOTKEY_API_KEY }),
      ...(process.env.ROOTKEY_API_URL ? { ROOTKEY_API_URL: process.env.ROOTKEY_API_URL } : {}),
      ROOTKEY_LOG_LEVEL: process.env.ROOTKEY_LOG_LEVEL ?? 'warn',
    },
  }),
);

let step = 0;
const cleanup = [];

async function call(name, args = {}) {
  step += 1;
  process.stdout.write(`${String(step).padStart(2, '0')}. ${name} ... `);
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  if (result.isError) {
    console.log('FAILED');
    console.log(`    ${text}`);
    throw new Error(`${name} failed`);
  }
  console.log('ok');
  // The payload is always the last text block; a notice, when there is one, comes before it. Parsing from the
  // last "{" would pick out a nested object, which the personal access token diagnostic now has.
  const last = [...result.content].reverse().find((part) => part.type === 'text');
  try {
    return last ? JSON.parse(last.text) : {};
  } catch {
    return {};
  }
}

try {
  const env = await call('rootkey_get_environment_info');
  console.log(
    usingToken
      ? `    ${env.environment} at ${env.baseUrl} (personal access token of ${env.user?.email ?? 'unknown user'}, ${env.dataMode} data, ${env.registeredTools} tools)`
      : `    ${env.environment} at ${env.baseUrl} (${env.keyMode} key, ${env.registeredTools} tools)`,
  );
  if (usingToken && !env.organization) throw new Error(`the organization was not usable: ${env.organizationError ?? 'none selected'}`);

  await call('rootkey_list_vaults', { limit: 5 });
  await call('rootkey_list_tables', { limit: 5 });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const vault = await call('rootkey_create_vault', {
    vaultName: `mcp-smoke-${stamp}`,
    description: 'Temporary vault created by the rootkey-mcp smoke test.',
  });
  const vaultAddress = vault.address;
  if (!vaultAddress) throw new Error('rootkey_create_vault returned no address');
  console.log(`    vault ${vaultAddress}`);
  cleanup.push(() => call('rootkey_delete_vault', { vaultAddress }));

  const dir = await mkdtemp(path.join(tmpdir(), 'rootkey-smoke-'));
  const filePath = path.join(dir, 'smoke.txt');
  await writeFile(filePath, `rootkey-mcp smoke test ${stamp}\n`);

  const uploaded = await call('rootkey_upload_file', { filePath, vaultAddress });
  const fileId = uploaded.file?.id;
  console.log(`    tx ${uploaded.transactionHash ?? 'n/a'}, file id ${fileId ?? 'not resolved yet'}`);

  const listed = await call('rootkey_list_files', { vaultAddress, limit: 5 });
  console.log(`    ${listed.items.length} file(s) in the vault`);

  if (fileId) {
    cleanup.unshift(() => call('rootkey_delete_file', { fileId, vaultAddress }));
    await call('rootkey_get_file', { fileId, vaultAddress });
    await call('rootkey_validate_file', { fileId, filePath, vaultAddress });
    const saved = await call('rootkey_download_file', { fileId, outputPath: dir });
    console.log(`    downloaded to ${saved.savedPath} (${saved.sizeBytes} bytes)`);
    await call('rootkey_get_file_history', { fileId, limit: 5 });
    await call('rootkey_get_file_validations', { fileId, limit: 5 });
  } else {
    console.log('    skipping file detail steps: anchoring has not surfaced an id yet');
  }

  const record = await call('rootkey_create_record', {
    vaultAddress,
    recordData: { reference: `smoke-${stamp}`, source: 'rootkey-mcp smoke test' },
  });
  const recordId = record.record?.__meta?.id;
  console.log(`    record ${recordId ?? 'not resolved'} (match: ${record.matched ?? 'none'})`);
  if (recordId) cleanup.unshift(() => call('rootkey_delete_record', { recordId, vaultAddress }));

  await call('rootkey_list_records', { vaultAddress, limit: 5 });
  // The API refuses recovery points to a personal access token, and the server then does not register the tool.
  if (!usingToken) await call('rootkey_list_recovery_points');

  console.log('\nAll steps passed. Cleaning up.');
} catch (error) {
  console.error(`\nSmoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  for (const undo of cleanup) {
    try {
      await undo();
    } catch (error) {
      console.error(`    cleanup step failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
  await client.close();
}
