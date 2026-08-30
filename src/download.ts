import { createWriteStream } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { ToolInputError } from './errors.js';
import { assertWithinDirectory } from './paths.js';

export interface SaveResult {
  savedPath: string;
  sizeBytes: number;
  fileName: string;
}

export interface SaveOptions {
  /** A full file path or an existing directory. When omitted, the configured download directory is used. */
  outputPath?: string | undefined;
  /** Configured fallback directory (ROOTKEY_DOWNLOAD_DIR). */
  downloadDir?: string | undefined;
  /** Used when the response carries no usable Content-Disposition filename. */
  fallbackName: string;
  /** Called as bytes land. `total` is undefined when the response carries no Content-Length. */
  onProgress?: ((bytes: number, total: number | undefined) => void) | undefined;
  /**
   * When set, the resolved target must land inside this directory. Read-only mode sets it: a mode
   * that promises to change nothing must not let a caller-supplied outputPath drop a file anywhere
   * on the disk.
   */
  confineTo?: string | undefined;
}

/** Streams a response body straight to disk - nothing is buffered and nothing is inlined into chat. */
export async function saveResponseToFile(response: Response, options: SaveOptions): Promise<SaveResult> {
  if (!response.body) {
    throw new ToolInputError('The API returned an empty response body, so there is nothing to save.');
  }

  const suggested = filenameFromContentDisposition(response.headers.get('content-disposition'));
  const target = await resolveTarget(options, suggested ?? options.fallbackName);

  await mkdir(path.dirname(target), { recursive: true });

  const declared = Number(response.headers.get('content-length'));
  const total = Number.isFinite(declared) && declared > 0 ? declared : undefined;
  const source = Readable.fromWeb(response.body as ReadableStream);

  if (options.onProgress) {
    let seen = 0;
    const report = options.onProgress;
    source.on('data', (chunk: Buffer) => {
      seen += chunk.length;
      report(seen, total);
    });
  }

  await pipeline(source, createWriteStream(target));

  const { size } = await stat(target);
  return { savedPath: target, sizeBytes: size, fileName: path.basename(target) };
}

async function resolveTarget(options: SaveOptions, derivedName: string): Promise<string> {
  const safeName = sanitizeFileName(derivedName);
  const chosen = await chooseTarget(options, safeName);

  if (options.confineTo) {
    await assertWithinDirectory(chosen, options.confineTo, 'the downloaded file');
  }

  return dedupe(chosen);
}

async function chooseTarget(options: SaveOptions, safeName: string): Promise<string> {
  if (options.outputPath && options.outputPath.trim() !== '') {
    const resolved = path.resolve(options.outputPath);
    if (await isDirectory(resolved)) return path.join(resolved, safeName);
    // A trailing separator means the caller meant a directory even if it does not exist yet.
    if (/[\\/]$/.test(options.outputPath)) return path.join(resolved, safeName);
    return resolved;
  }

  return path.join(await defaultDirectory(options.downloadDir), safeName);
}

export async function resolveDownloadDirectory(configured: string | undefined): Promise<string> {
  return defaultDirectory(configured);
}

async function defaultDirectory(configured: string | undefined): Promise<string> {
  if (configured && configured.trim() !== '') return path.resolve(configured);
  const downloads = path.join(homedir(), 'Downloads');
  if (await isDirectory(downloads)) return downloads;
  return tmpdir();
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Never overwrite: "report.pdf" becomes "report (1).pdf" when the path is taken. */
async function dedupe(target: string): Promise<string> {
  if (!(await exists(target))) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const stem = path.basename(target, ext);
  for (let counter = 1; counter < 1000; counter++) {
    const candidate = path.join(dir, `${stem} (${counter})${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new ToolInputError(`Could not find a free filename next to ${target}.`);
}

const ILLEGAL_NAME_CHARS = '<>:"|?*';

/** A server-supplied name is untrusted input: keep the basename only, never a path. */
export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = Array.from(base)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code > 31 && code !== 127 && !ILLEGAL_NAME_CHARS.includes(char);
    })
    .join('')
    .trim()
    .replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'rootkey-download';
}

export function filenameFromContentDisposition(header: string | null): string | undefined {
  if (!header) return undefined;

  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended?.[2]) {
    try {
      return decodeURIComponent(extended[2].trim());
    } catch {
      return extended[2].trim();
    }
  }

  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(header);
  if (quoted?.[1]) return quoted[1];

  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  if (bare?.[1]) return bare[1].trim();

  return undefined;
}
