import { openAsBlob } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../config.js';
import { ApiError, NetworkError, ToolInputError } from '../errors.js';
import { resolveDownloadDirectory } from '../download.js';
import { assertReadableFile } from '../paths.js';
import type { RootKeyClient } from '../http.js';
import { log } from '../log.js';

export interface ToolContext {
  client: RootKeyClient;
  config: Config;
}

/** What a handler hands back: `notice` is prose shown before the JSON payload. */
export interface ToolOutput {
  notice?: string;
  data: unknown;
}

export interface HandlerExtra {
  signal?: AbortSignal | undefined;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /** Registered when the server runs in read-only mode: the tool changes nothing in the workspace. */
  readOnly?: boolean;
  /**
   * Reads nothing from the workspace but writes a file to the local disk. Kept apart from `readOnly`
   * because the two answer different questions: whether the tool may run in read-only mode, and
   * whether `readOnlyHint` may claim it modifies nothing. A download is yes to the first, no to the
   * second.
   */
  writesLocalFiles?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  /** Local-only tools do not talk to the API. */
  local?: boolean;
  /**
   * Declared only where this server shapes the payload itself. Where a tool hands back the API
   * response untouched, a schema would be a guess about someone else's contract that goes stale
   * silently, so those tools deliberately have none.
   */
  outputSchema?: z.ZodTypeAny;
  handler: (args: Record<string, unknown>, ctx: ToolContext, extra: HandlerExtra) => Promise<ToolOutput>;
}

export function registerTools(server: McpServer, ctx: ToolContext, definitions: ToolDefinition[]): string[] {
  const registered: string[] = [];

  for (const definition of definitions) {
    if (ctx.config.readOnly && definition.readOnly !== true) continue;

    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        // `.strict()` rather than the raw shape: it emits `additionalProperties: false`, which is the
        // form the spec recommends for a no-argument tool, and it turns a hallucinated or misspelled
        // argument into an error the model can read and correct instead of a value silently dropped.
        inputSchema: z.object(definition.inputSchema).strict(),
        ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
        annotations: {
          title: definition.title,
          readOnlyHint: definition.readOnly === true && definition.writesLocalFiles !== true,
          destructiveHint: definition.destructive === true,
          idempotentHint: definition.idempotent === true,
          openWorldHint: definition.local !== true,
        },
      },
      async (args: Record<string, unknown>, extra: { signal?: AbortSignal }): Promise<CallToolResult> => {
        try {
          const output = await definition.handler(args ?? {}, ctx, { signal: extra?.signal });
          return toolSuccess(output, definition.outputSchema !== undefined);
        } catch (error) {
          return toolFailure(definition.name, error);
        }
      },
    );

    registered.push(definition.name);
  }

  return registered;
}

/**
 * The JSON is emitted compactly. Pretty-printing a page of results costs real tokens on every call
 * for indentation no model needs, and a client that wants it formatted can format it.
 *
 * `structuredContent` carries the same value where the tool declares an output schema; the text block
 * stays regardless, because the spec asks for it as the backwards-compatible half.
 */
function toolSuccess(output: ToolOutput, structured: boolean): CallToolResult {
  const content: CallToolResult['content'] = [];
  if (output.notice) content.push({ type: 'text', text: output.notice });
  content.push({ type: 'text', text: JSON.stringify(output.data ?? null) });

  if (!structured) return { content };
  return { content, structuredContent: output.data as Record<string, unknown> };
}

function toolFailure(toolName: string, error: unknown): CallToolResult {
  const message =
    error instanceof ApiError
      ? error.toDisplayString()
      : error instanceof ToolInputError || error instanceof NetworkError
        ? error.message
        : error instanceof Error
          ? `Unexpected failure: ${error.message}`
          : `Unexpected failure: ${String(error)}`;

  log.debug(`${toolName} failed: ${message}`);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/* ------------------------------------------------------------------ *
 * Shared argument fragments
 * ------------------------------------------------------------------ */

export const vaultAddressArg = z
  .string()
  .min(1)
  .describe(
    'Vault (or table) address, for example 0xdf67.... Copy it from the ROOTKey dashboard: ' +
      'the API has no endpoint that lists vaults.',
  );

export const paginationArgs = {
  cursor: z.string().optional().describe('Cursor from a previous result (pagination.nextCursor).'),
  limit: z.number().int().min(1).max(100).optional().describe('Items per page. The API defaults to 10.'),
  order: z.enum(['asc', 'desc']).optional().describe('Sort direction by creation time. The API defaults to desc.'),
};

export const isoDateTime = z
  .string()
  .datetime({ offset: true })
  .describe('ISO 8601 timestamp, for example 2026-07-30T12:00:00Z.');

export const statusFilter = z
  .enum(['pending', 'registered', 'error'])
  .describe(
    'Filter by anchoring status. Filters are lowercase while returned values are uppercase ' +
      '(PENDING, REGISTERED, FAILED); "error" matches FAILED.',
  );

/**
 * The envelope `normalizePage` produces. `passthrough` matters: the API's extra top-level fields
 * (chainId, currentHash, previousHash) are carried through deliberately, and a closed schema would
 * make the SDK reject the very payloads this server exists to relay.
 */
export const pageOutputSchema = z
  .object({
    items: z.array(z.unknown()).describe('The rows for this page.'),
    pagination: z.object({
      nextCursor: z.string().nullable().describe('Pass back as `cursor` to page forward. Null on the last page.'),
      previousCursor: z.string().nullable(),
    }),
    metadata: z.unknown().optional().describe('Aggregate counters, when the endpoint reports any.'),
  })
  .passthrough();

export const savedFileOutputSchema = z
  .object({
    savedPath: z.string().describe('Absolute path on the machine running this server.'),
    sizeBytes: z.number(),
    fileName: z.string(),
  })
  .passthrough();

export function pagedQuery(args: Record<string, unknown>): Record<string, string | number | undefined> {
  return {
    cursor: args.cursor as string | undefined,
    limit: args.limit as number | undefined,
    order: args.order as string | undefined,
  };
}

/** Reads a required string argument, rejecting whitespace-only values. */
export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolInputError(`Argument "${key}" is required.`);
  }
  return value.trim();
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value.trim();
}

/**
 * Read-only mode promises the server changes nothing. It cannot promise that about the API and the
 * disk at once unless downloads are pinned somewhere predictable, so in that mode a caller-supplied
 * outputPath may not leave the download directory. Outside it, undefined: no confinement.
 */
export async function readOnlyWriteRoot(ctx: ToolContext): Promise<string | undefined> {
  if (!ctx.config.readOnly) return undefined;
  return resolveDownloadDirectory(ctx.config.downloadDir);
}

/* ------------------------------------------------------------------ *
 * Multipart uploads
 * ------------------------------------------------------------------ */

/**
 * Builds the multipart body the upload endpoints expect. `openAsBlob` gives a lazily-read Blob so
 * a large file is streamed rather than held in memory; the readFile path is a fallback for
 * runtimes that lack it.
 */
export async function buildFileForm(
  filePath: string,
  fields: Record<string, string | undefined>,
  allowedRoots: string[],
): Promise<{ form: FormData; fileName: string; sizeBytes: number }> {
  const resolved = await assertReadableFile(filePath, allowedRoots);

  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new ToolInputError(`No file found at "${resolved}". Pass an absolute path on the machine running this server.`);
  }
  if (!info.isFile()) {
    throw new ToolInputError(`"${resolved}" is a directory, not a file.`);
  }

  const fileName = fields.fileName ?? path.basename(resolved);
  const blob =
    typeof openAsBlob === 'function' ? await openAsBlob(resolved) : new Blob([await readFile(resolved)]);

  const form = new FormData();
  form.append('file', blob, fileName);
  for (const [key, value] of Object.entries({ ...fields, fileName })) {
    if (value !== undefined && value !== '') form.append(key, value);
  }

  return { form, fileName, sizeBytes: info.size };
}
