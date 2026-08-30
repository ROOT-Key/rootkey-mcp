import { openAsBlob } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../config.js';
import { ApiError, NetworkError, ToolInputError } from '../errors.js';
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
  /** Registered when the server runs in read-only mode. */
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  /** Local-only tools do not talk to the API. */
  local?: boolean;
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
        annotations: {
          title: definition.title,
          readOnlyHint: definition.readOnly === true,
          destructiveHint: definition.destructive === true,
          idempotentHint: definition.idempotent === true,
          openWorldHint: definition.local !== true,
        },
      },
      async (args: Record<string, unknown>, extra: { signal?: AbortSignal }): Promise<CallToolResult> => {
        try {
          const output = await definition.handler(args ?? {}, ctx, { signal: extra?.signal });
          return toolSuccess(output);
        } catch (error) {
          return toolFailure(definition.name, error);
        }
      },
    );

    registered.push(definition.name);
  }

  return registered;
}

function toolSuccess(output: ToolOutput): CallToolResult {
  const content: CallToolResult['content'] = [];
  if (output.notice) content.push({ type: 'text', text: output.notice });
  content.push({ type: 'text', text: JSON.stringify(output.data ?? null, null, 2) });
  return { content };
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
