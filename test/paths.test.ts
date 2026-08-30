import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolInputError } from '../src/errors.js';
import { assertReadableFile, parseAllowedRoots } from '../src/paths.js';

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'rootkey-paths-'));
}

describe('parseAllowedRoots', () => {
  it('splits on the platform path delimiter and resolves each entry', () => {
    const roots = parseAllowedRoots(['alpha', 'beta'].join(path.delimiter));
    expect(roots).toEqual([path.resolve('alpha'), path.resolve('beta')]);
  });

  it('returns undefined for unset or empty values, so the caller can fall back', () => {
    expect(parseAllowedRoots(undefined)).toBeUndefined();
    expect(parseAllowedRoots('   ')).toBeUndefined();
    expect(parseAllowedRoots(path.delimiter)).toBeUndefined();
  });
});

describe('assertReadableFile', () => {
  it('accepts a file inside an allowed root', async () => {
    const root = await scratch();
    const file = path.join(root, 'report.pdf');
    await writeFile(file, 'x');

    await expect(assertReadableFile(file, [root])).resolves.toContain('report.pdf');
  });

  it('refuses a file outside every allowed root, and names the roots', async () => {
    const root = await scratch();
    const outside = await scratch();
    const file = path.join(outside, 'secret.txt');
    await writeFile(file, 'x');

    await expect(assertReadableFile(file, [root])).rejects.toThrow(ToolInputError);
    await expect(assertReadableFile(file, [root])).rejects.toThrow(/ROOTKEY_ALLOWED_DIRS/);
  });

  it('refuses traversal out of a root', async () => {
    const parent = await scratch();
    const root = path.join(parent, 'inbox');
    await mkdir(root);
    await writeFile(path.join(parent, 'escaped.txt'), 'x');

    await expect(assertReadableFile(path.join(root, '..', 'escaped.txt'), [root])).rejects.toThrow(
      ToolInputError,
    );
  });

  // The case the confinement exists for: a hidden directory under an allowed root.
  it('refuses a hidden directory below the root', async () => {
    const root = await scratch();
    const hidden = path.join(root, '.ssh');
    await mkdir(hidden);
    await writeFile(path.join(hidden, 'id_rsa'), 'x');

    await expect(assertReadableFile(path.join(hidden, 'id_rsa'), [root])).rejects.toThrow(
      /hidden directory/,
    );
  });

  it('allows a hidden directory that was allowlisted explicitly', async () => {
    const base = await scratch();
    const hidden = path.join(base, '.exports');
    await mkdir(hidden);
    const file = path.join(hidden, 'ledger.csv');
    await writeFile(file, 'x');

    await expect(assertReadableFile(file, [hidden])).resolves.toContain('ledger.csv');
  });

  it('resolves symlinks before checking, so a link cannot walk out of a root', async () => {
    const root = await scratch();
    const outside = await scratch();
    const target = path.join(outside, 'secret.txt');
    await writeFile(target, 'x');

    const link = path.join(root, 'innocent.txt');
    try {
      await symlink(target, link);
    } catch {
      return; // Windows without developer mode cannot create symlinks; the rule is covered above.
    }

    await expect(assertReadableFile(link, [root])).rejects.toThrow(ToolInputError);
  });
});
