import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';

/**
 * Prompts are the half of the protocol a tool list cannot cover: they are user-initiated and they
 * encode a whole task, not a single call. Each one here is a job someone actually asks for, written
 * out with the ordering and the checks that make it come out right - which sequence to use, what to
 * confirm before writing, and which results are worth reporting back.
 *
 * The ones that write are registered only when the server can write, so read-only mode never offers
 * a workflow it would refuse halfway through.
 */

interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  argsSchema: z.ZodRawShape;
  /** Registered in read-only mode. */
  readOnly?: boolean;
  build: (args: Record<string, string | undefined>) => string;
}

const promptDefinitions: PromptDefinition[] = [
  {
    name: 'anchor_folder',
    title: 'Anchor every file in a folder',
    description: 'Upload and anchor each file in a local folder into a vault, then report what landed.',
    argsSchema: {
      folderPath: z.string().describe('Absolute path to the folder whose files should be anchored.'),
      vaultAddress: z.string().describe('Vault address to anchor into, for example 0xdf67....'),
    },
    build: ({ folderPath, vaultAddress }) =>
      [
        `Anchor every file in ${folderPath} into the ROOTKey vault ${vaultAddress}.`,
        '',
        'Work through it like this:',
        '1. List the folder and tell me what you found, including the total size, before uploading anything.',
        '2. Ask me to confirm. Anchoring consumes plan quota and a new version cannot be un-uploaded.',
        '3. Upload one file at a time with upload_file. If one fails, say so and keep going with the rest.',
        '4. Finish with a table: file name, size, resulting file id, and anchoring status.',
        '',
        'If a file is already in the vault under the same name, ask me whether I want a new version of it',
        'or want it skipped. Do not guess: uploading it creates a version, and that is permanent.',
      ].join('\n'),
  },

  {
    name: 'compliance_evidence_pack',
    title: 'Assemble the evidence trail for a file',
    description: 'Gather the anchor, activity history and validation record for one file, as audit evidence.',
    readOnly: true,
    argsSchema: {
      fileId: z.string().describe('The file to document.'),
      vaultAddress: z.string().describe('Address of the vault holding it.'),
    },
    build: ({ fileId, vaultAddress }) =>
      [
        `Put together the compliance evidence for ROOTKey file ${fileId} in vault ${vaultAddress}.`,
        '',
        'Collect, in this order:',
        '1. get_file - the hashes, the transaction hash, the contract address and the expiration.',
        '2. get_file_history - who touched it, when, and through which API key.',
        '3. get_file_validations - every integrity check performed against it.',
        '4. list_file_versions - the version chain, so a reader can see what changed and when.',
        '',
        'Then write it up as a short report: what the file is, when it was anchored and to which chain,',
        'what the audit trail shows, and whether any validation ever failed.',
        '',
        'State plainly what the evidence does NOT cover. The on-chain anchor proves the file existed in that',
        'exact form at that time; it does not prove who authored it or that the contents are true.',
      ].join('\n'),
  },

  {
    name: 'verify_local_copies',
    title: 'Check local files against their anchors',
    description: 'Validate local copies of anchored files and report any that no longer match.',
    argsSchema: {
      folderPath: z.string().describe('Folder holding the local copies to verify.'),
      vaultAddress: z.string().describe('Vault the files were anchored into.'),
    },
    build: ({ folderPath, vaultAddress }) =>
      [
        `Check the files in ${folderPath} against what is anchored in ROOTKey vault ${vaultAddress}.`,
        '',
        '1. list_files on the vault to see what is anchored.',
        '2. Match them to the local files by name, and tell me about anything on one side but not the other',
        '   before validating - a missing file is a finding too.',
        '3. validate_file for each pair. Note that each validation is recorded and consumes plan quota, so',
        '   confirm with me first if there are more than a handful.',
        '4. Report ownership, integrity and validity per file, and lead with the failures rather than',
        '   burying them under the passes.',
      ].join('\n'),
  },

  {
    name: 'backup_workspace',
    title: 'Create and download a recovery point',
    description: 'Build an encrypted backup archive, wait for it, and download it.',
    argsSchema: {
      name: z.string().describe('Name for the recovery point.'),
      outputPath: z.string().optional().describe('Where to save the archive. Defaults to the download directory.'),
    },
    build: ({ name, outputPath }) =>
      [
        `Create a ROOTKey recovery point called "${name}", covering the whole workspace, and download it.`,
        '',
        '1. create_recovery_point with scope "global".',
        '2. Show me the one-time password immediately and on its own. It is shown once, it can never be',
        '   recovered, and the archive is useless without it. Tell me it is now in this conversation, so I',
        '   can decide what to do about that.',
        '3. wait_for_recovery_point until it reports completed. If it times out, say so and call it again -',
        '   a long build is normal and is not a failure.',
        outputPath
          ? `4. download_recovery_point to ${outputPath}, then confirm the saved path and size.`
          : '4. download_recovery_point, then confirm the saved path and size.',
        '',
        'Do not repeat the password in your final summary. Once is what it is for.',
      ].join('\n'),
  },
];

export function registerPrompts(server: McpServer, config: Config): string[] {
  const registered: string[] = [];

  for (const definition of promptDefinitions) {
    if (config.readOnly && definition.readOnly !== true) continue;

    server.registerPrompt(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        argsSchema: definition.argsSchema,
      },
      (args: Record<string, string | undefined>) => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: definition.build(args) } }],
      }),
    );

    registered.push(definition.name);
  }

  return registered;
}
