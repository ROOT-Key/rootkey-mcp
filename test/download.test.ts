import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { filenameFromContentDisposition, sanitizeFileName, saveResponseToFile } from '../src/download.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'rootkey-mcp-test-'));
  tempDirs.push(dir);
  return dir;
}

function binaryResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream', ...headers } });
}

afterEach(() => {
  tempDirs.length = 0;
});

describe('filenameFromContentDisposition', () => {
  it('reads a quoted filename', () => {
    expect(filenameFromContentDisposition('attachment; filename="q3 report.pdf"')).toBe('q3 report.pdf');
  });

  it('prefers the RFC 5987 extended form and decodes it', () => {
    const header = "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''relat%C3%B3rio.pdf";
    expect(filenameFromContentDisposition(header)).toBe('relatório.pdf');
  });

  it('reads an unquoted filename', () => {
    expect(filenameFromContentDisposition('attachment; filename=data.csv')).toBe('data.csv');
  });

  it('returns undefined when there is no header or no filename', () => {
    expect(filenameFromContentDisposition(null)).toBeUndefined();
    expect(filenameFromContentDisposition('attachment')).toBeUndefined();
  });
});

describe('sanitizeFileName', () => {
  it('keeps digits, letters and spaces', () => {
    expect(sanitizeFileName('Q3 2026 report v2.pdf')).toBe('Q3 2026 report v2.pdf');
  });

  it('strips any directory component from a server-supplied name', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Windows\\System32\\evil.dll')).toBe('evil.dll');
  });

  it('removes characters that are illegal in file names', () => {
    expect(sanitizeFileName('in<va>li:d"name?.txt')).toBe('invalidname.txt');
  });

  it('falls back to a default when nothing usable remains', () => {
    expect(sanitizeFileName('...')).toBe('rootkey-download');
    expect(sanitizeFileName('')).toBe('rootkey-download');
  });
});

describe('saveResponseToFile', () => {
  it('saves into a directory using the Content-Disposition filename', async () => {
    const dir = await makeTempDir();
    const result = await saveResponseToFile(
      binaryResponse('hello world', { 'content-disposition': 'attachment; filename="anchor.txt"' }),
      { outputPath: dir, fallbackName: 'fallback.bin' },
    );

    expect(result.fileName).toBe('anchor.txt');
    expect(result.savedPath).toBe(path.join(dir, 'anchor.txt'));
    expect(result.sizeBytes).toBe(11);
    expect(await readFile(result.savedPath, 'utf8')).toBe('hello world');
  });

  it('uses the fallback name when the response suggests none', async () => {
    const dir = await makeTempDir();
    const result = await saveResponseToFile(binaryResponse('data'), {
      outputPath: dir,
      fallbackName: 'rootkey-file-abc123',
    });
    expect(result.fileName).toBe('rootkey-file-abc123');
  });

  it('treats an explicit path as the target file', async () => {
    const dir = await makeTempDir();
    const target = path.join(dir, 'nested', 'custom-name.bin');
    const result = await saveResponseToFile(binaryResponse('data'), { outputPath: target, fallbackName: 'x.bin' });
    expect(result.savedPath).toBe(target);
  });

  it('never overwrites an existing file', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'anchor.txt'), 'original');

    const first = await saveResponseToFile(
      binaryResponse('second', { 'content-disposition': 'attachment; filename="anchor.txt"' }),
      { outputPath: dir, fallbackName: 'x' },
    );
    expect(path.basename(first.savedPath)).toBe('anchor (1).txt');

    const second = await saveResponseToFile(
      binaryResponse('third', { 'content-disposition': 'attachment; filename="anchor.txt"' }),
      { outputPath: dir, fallbackName: 'x' },
    );
    expect(path.basename(second.savedPath)).toBe('anchor (2).txt');

    expect(await readFile(path.join(dir, 'anchor.txt'), 'utf8')).toBe('original');
  });

  it('falls back to the configured download directory when no path is given', async () => {
    const dir = await makeTempDir();
    const result = await saveResponseToFile(binaryResponse('data'), {
      downloadDir: dir,
      fallbackName: 'archive.zip',
    });
    expect(result.savedPath).toBe(path.join(dir, 'archive.zip'));
  });
});
