import { realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { ToolInputError } from './errors.js';

/**
 * Upload and validate read a file off the machine running this server and send it to the ROOTKey API.
 * That is a read primitive pointed at the local disk, driven by whatever path the model was told to
 * use - including by a document the model is merely summarising. Confining it is the difference
 * between "the agent uploaded the report" and "the agent uploaded ~/.ssh/id_rsa".
 *
 * Two rules, both enforced after resolving symlinks so a link cannot walk out of a root:
 *   1. the file must sit inside one of the allowed roots;
 *   2. no path segment BELOW the matched root may begin with a dot.
 *
 * Rule 2 is what covers the interesting cases - ~/.ssh, ~/.aws, ~/.config, a stray .env - while
 * leaving ~/Documents and ~/Downloads alone. It is scoped below the root on purpose: allowlisting
 * a directory that is itself hidden is an explicit act and stays permitted.
 */

/** Home, the OS temp directory, and wherever the server was started from. */
export function defaultAllowedRoots(): string[] {
  return [homedir(), tmpdir(), process.cwd()];
}

export function parseAllowedRoots(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const roots = raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => path.resolve(entry));
  return roots.length > 0 ? roots : undefined;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hasHiddenSegmentBelow(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === '') return false;
  return relative.split(/[\/]/).some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..');
}

/** Resolves symlinks; falls back to the lexical path when the entry cannot be resolved. */
async function canonical(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

/**
 * Throws a ToolInputError naming the roots when `filePath` is out of bounds. The message is written
 * for the model: it says which rule was broken and which variable widens it.
 */
export async function assertReadableFile(filePath: string, allowedRoots: string[]): Promise<string> {
  const resolved = await canonical(path.resolve(filePath));
  const roots = await Promise.all(allowedRoots.map(canonical));

  const matched = roots.find((root) => isInside(resolved, root));
  if (matched === undefined) {
    throw new ToolInputError(
      `Refusing to read "${resolved}": it is outside the directories this server may upload from ` +
        `(${roots.join(', ')}). Move the file into one of them, or set ROOTKEY_ALLOWED_DIRS to include ` +
        'the directory you meant.',
    );
  }

  if (hasHiddenSegmentBelow(resolved, matched)) {
    throw new ToolInputError(
      `Refusing to read "${resolved}": it sits in a hidden directory, and those hold credentials far ` +
        'more often than they hold documents a user meant to anchor. If this file really is the ' +
        'intended one, set ROOTKEY_ALLOWED_DIRS to the hidden directory itself.',
    );
  }

  return resolved;
}
