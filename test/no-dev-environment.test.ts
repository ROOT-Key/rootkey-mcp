import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apiErrorFromBody } from '../src/errors.js';
import { SERVER_INSTRUCTIONS } from '../src/server.js';
import { SERVER_VERSION } from '../src/version.js';
import { connectTestClient } from './helpers.js';

/**
 * There is no public development environment. One public API (https://api.rootkey.ai/api-v1/) serves
 * everything; test vs live is decided by the API key's data partition on that same API, and existing keys
 * are unprefixed UUIDs, so a key prefix is not a reliable environment signal. These guards keep the 0.1.0
 * mistake (a fictional dev-api host, advertised to users and to the model) from coming back.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), 'utf8');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const shippedSources = [
  ...walk(path.join(ROOT, 'src')),
  ...walk(path.join(ROOT, 'scripts')),
  path.join(ROOT, 'README.md'),
  path.join(ROOT, '.mcp.json'),
].map((file) => ({ file, rel: path.relative(ROOT, file).replace(/\\/g, '/'), text: readFileSync(file, 'utf8') }));

describe('no development environment in the shipped sources', () => {
  it('scans the files it claims to scan', () => {
    const rels = shippedSources.map((s) => s.rel);
    expect(rels).toContain('src/config.ts');
    expect(rels).toContain('src/server.ts');
    expect(rels).toContain('scripts/smoke.mjs');
    expect(rels).toContain('README.md');
    expect(rels).toContain('.mcp.json');
  });

  it.each(shippedSources.map((s) => [s.rel, s.text] as const))('%s never mentions a dev-api host', (_rel, text) => {
    expect(text).not.toMatch(/dev-api/i);
  });

  it.each(shippedSources.map((s) => [s.rel, s.text] as const))('%s never references DEVELOPMENT_BASE_URL', (_rel, text) => {
    expect(text).not.toContain('DEVELOPMENT_BASE_URL');
  });

  it.each(shippedSources.map((s) => [s.rel, s.text] as const))(
    '%s never tells anyone to set ROOTKEY_ENV to development',
    (_rel, text) => {
      expect(text).not.toMatch(/ROOTKEY_ENV["']?\s*[=:]\s*["']?development/i);
    },
  );

  // The word may only appear to say there is no such environment, as a section heading, or as the
  // literal the config loader rejects. Anything else is a positive claim about a development environment.
  it.each(shippedSources.map((s) => [s.rel, s] as const))(
    '%s only uses the word "development" to deny it, to head a section, or to reject it in config.ts',
    (_rel, source) => {
      const offenders = source.text
        .split(/\r?\n/)
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => /development/i.test(line))
        .filter(({ line }) => !/^#+\s*development\s*$/i.test(line.trim()))
        .filter(({ line }) => !(source.rel === 'src/config.ts' && /['"]development['"]/.test(line)))
        .filter(({ line }) => !/\b(no|not|never|isn't|doesn't|does not|cannot|without|obsolete|no longer|there is no)\b/i.test(line));
      expect(offenders).toEqual([]);
    },
  );

  it('keeps .mcp.json on the production API', () => {
    const config = JSON.parse(read('.mcp.json')) as { mcpServers: Record<string, { env?: Record<string, string> }> };
    for (const server of Object.values(config.mcpServers)) {
      const value = server.env?.ROOTKEY_ENV;
      expect(value === undefined || value === 'production').toBe(true);
    }
  });
});

describe('README accuracy', () => {
  const readme = read('README.md');

  it('documents ROOTKEY_ENV as production-only and points self-hosters at ROOTKEY_API_URL', () => {
    const row = readme.split(/\r?\n/).find((line) => line.startsWith('| `ROOTKEY_ENV`')) ?? '';
    // Either the row is gone entirely, or it documents production as the only value.
    if (row) {
      expect(row).toContain('production');
      expect(row).not.toMatch(/development/i);
    }
    expect(readme).toContain('ROOTKEY_API_URL');
  });

  it('explains that test and live data are separated by the key on the same API', () => {
    expect(readme).toMatch(/test key/i);
    expect(readme).toContain('https://api.rootkey.ai');
  });

  // Not verified against the API: test-partition keys on the public API may still anchor and bill.
  it('makes no unverified claim that testing anchors nothing or costs nothing', () => {
    expect(readme).not.toMatch(/anchors nothing/i);
    expect(readme).not.toMatch(/costs no credits/i);
    expect(readme).not.toMatch(/Polygon Mainnet and costs/i);
  });
});

describe('model-facing text', () => {
  const claimsPrefixDecidesEnvironment =
    /\brk_(test|live)_\S*\s+(keys?\s+)?(only\s+)?(work|works|need|needs|require|requires|run|runs|against|belong)/i;

  it('server instructions never invent a development API or tie the key prefix to the environment', () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(/development/i);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/dev-api/i);
    expect(SERVER_INSTRUCTIONS).not.toMatch(claimsPrefixDecidesEnvironment);
  });

  it('server instructions still point the model at the environment diagnostic', () => {
    expect(SERVER_INSTRUCTIONS).toContain('rootkey_get_environment_info');
  });

  it('401 guidance never claims test keys need a development API', () => {
    const message = apiErrorFromBody(401, undefined, '').message;
    expect(message).toContain('ROOTKEY_API_KEY');
    expect(message).not.toMatch(/development/i);
    expect(message).not.toMatch(/dev-api/i);
    expect(message).not.toMatch(claimsPrefixDecidesEnvironment);
    expect(message).not.toMatch(/only work/i);
  });

  it('no tool title, description or schema mentions a development environment', async () => {
    const { client, close } = await connectTestClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(tools);
      expect(serialized).not.toMatch(/development/i);
      expect(serialized).not.toMatch(/dev-api/i);
      expect(serialized).not.toMatch(claimsPrefixDecidesEnvironment);
    } finally {
      await close();
    }
  });

  it('no prompt description mentions a development environment', async () => {
    const { client, close } = await connectTestClient();
    try {
      const { prompts } = await client.listPrompts();
      expect(JSON.stringify(prompts)).not.toMatch(/development|dev-api/i);
    } finally {
      await close();
    }
  });

  it('the environment diagnostic does not oversell keyMode, which is unknown for unprefixed keys', async () => {
    const { client, close } = await connectTestClient();
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'rootkey_get_environment_info');
      const properties = (tool?.outputSchema?.properties ?? {}) as Record<string, { description?: string }>;
      expect(properties.keyMode?.description ?? '').toMatch(/unknown/i);
    } finally {
      await close();
    }
  });
});

describe('release 0.1.1', () => {
  it('has the same version in package.json, package-lock.json (both root fields) and the server', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    const lock = JSON.parse(read('package-lock.json')) as {
      version: string;
      packages: Record<string, { version: string }>;
    };
    expect(pkg.version).toBe('0.1.1');
    expect(lock.version).toBe('0.1.1');
    expect(lock.packages['']?.version).toBe('0.1.1');
    expect(SERVER_VERSION).toBe('0.1.1');
  });
});

// This is the file that reaches npm, so it is the one that matters. `npm test` rebuilds it first.
describe('built bundle (dist/index.js)', () => {
  const bundlePath = path.join(ROOT, 'dist', 'index.js');

  it('exists', () => {
    expect(existsSync(bundlePath)).toBe(true);
  });

  it('contains no dev-api host, DEVELOPMENT_BASE_URL or development-API claim', () => {
    const bundle = readFileSync(bundlePath, 'utf8');
    expect(bundle).not.toMatch(/dev-api/i);
    expect(bundle).not.toContain('DEVELOPMENT_BASE_URL');
    expect(bundle).not.toMatch(/development API/i);
    expect(bundle).not.toMatch(/ROOTKEY_ENV=development/i);
  });

  it('carries the 0.1.1 version string', () => {
    const bundle = readFileSync(bundlePath, 'utf8');
    expect(bundle).toContain('0.1.1');
    expect(bundle).not.toMatch(/SERVER_VERSION\s*=\s*["']0\.1\.0["']/);
  });
});

// Existing keys are unprefixed UUIDs, so the smoke script cannot tell a test key from a live one. It must
// refuse (before any network call) unless the key is rk_test_ or the operator acknowledges the risk.
describe('smoke script guard', () => {
  it.each(['3f2b8c1e-9d4a-4e7b-8a61-5c0d2e7f9a10', 'rk_live_abc'])('refuses key %s without ROOTKEY_SMOKE_ALLOW_LIVE', (key) => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'smoke.mjs')], {
      env: { PATH: process.env.PATH ?? '', ROOTKEY_SMOKE: '1', ROOTKEY_API_KEY: key },
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/test or live/i);
  });
});
