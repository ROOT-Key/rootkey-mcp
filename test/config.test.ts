import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  PRODUCTION_BASE_URL,
  keyMode,
  loadConfig,
  normalizeBaseUrl,
} from '../src/config.js';
import { SERVER_VERSION } from '../src/version.js';

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ ROOTKEY_API_KEY: 'rk_live_abc', ...extra }) as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('fails fast and names the variable when the API key is missing', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/ROOTKEY_API_KEY/);
  });

  it('rejects a whitespace-only API key', () => {
    expect(() => loadConfig({ ROOTKEY_API_KEY: '   ' } as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });

  it('defaults to the production API', () => {
    const config = loadConfig(env());
    expect(config.baseUrl).toBe(PRODUCTION_BASE_URL);
    expect(config.environment).toBe('production');
    expect(config.readOnly).toBe(false);
  });

  // There is no public development environment: test vs live is decided by the key's data partition on
  // the one public API. Pointing at a non-existent host would only produce confusing network errors.
  describe.each(['development', 'DEVELOPMENT', '  Development  ', 'dEvElOpMeNt'])('ROOTKEY_ENV=%j', (value) => {
    it('is refused with guidance that names the real alternatives', () => {
      let error: unknown;
      try {
        loadConfig(env({ ROOTKEY_ENV: value }));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('ROOTKEY_ENV');
      // Test keys run on the one public API.
      expect(message).toMatch(/production/i);
      expect(message).toMatch(/test key/i);
      // Self-hosted / on-prem deployments use ROOTKEY_API_URL.
      expect(message).toContain('ROOTKEY_API_URL');
      // Never point the user at a host that does not exist.
      expect(message).not.toMatch(/dev-api/i);
      expect(message).not.toMatch(/https?:\/\/dev/i);
    });
  });

  // 0.1.0 documented that ROOTKEY_API_URL overrides ROOTKEY_ENV, so a patch release must not break a
  // working self-hosted setup that still carries a stale ROOTKEY_ENV=development: the URL wins and the
  // config carries a warning, which the entry point prints on stderr after the log level is applied.
  describe('ROOTKEY_ENV=development together with ROOTKEY_API_URL', () => {
    const URL_ = 'https://staging.example/api-v1';

    it.each(['development', 'DEVELOPMENT', '  Development  '])(
      'does not throw for %j: the URL wins and the environment is custom',
      (value) => {
        const config = loadConfig(env({ ROOTKEY_ENV: value, ROOTKEY_API_URL: URL_ }));
        expect(config.baseUrl).toBe('https://staging.example/api-v1/');
        expect(config.environment).toBe('custom');
      },
    );

    it('keeps the production environment when the URL is the public API', () => {
      const config = loadConfig(env({ ROOTKEY_ENV: 'development', ROOTKEY_API_URL: 'https://api.rootkey.ai/api-v1' }));
      expect(config.environment).toBe('production');
    });

    it('carries exactly one warning that says the value is obsolete and can be removed', () => {
      const config = loadConfig(env({ ROOTKEY_ENV: 'development', ROOTKEY_API_URL: URL_ }));
      expect(config.warnings).toHaveLength(1);
      const [warning] = config.warnings;
      expect(warning).toContain('ROOTKEY_ENV');
      expect(warning).toMatch(/obsolete/i);
      expect(warning).toMatch(/remove/i);
      expect(warning).not.toContain('\n');
      expect(warning).not.toMatch(/dev-api/i);
    });

    it('loadConfig itself writes nothing: the warning is data, so the caller decides where and whether to print it', () => {
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        loadConfig(env({ ROOTKEY_ENV: 'development', ROOTKEY_API_URL: URL_ }));
        expect(err).not.toHaveBeenCalled();
        expect(out).not.toHaveBeenCalled();
      } finally {
        err.mockRestore();
        out.mockRestore();
      }
    });

    it('has no warnings when ROOTKEY_ENV is production, empty or unset', () => {
      expect(loadConfig(env({ ROOTKEY_ENV: 'production', ROOTKEY_API_URL: URL_ })).warnings).toEqual([]);
      expect(loadConfig(env({ ROOTKEY_ENV: '', ROOTKEY_API_URL: URL_ })).warnings).toEqual([]);
      expect(loadConfig(env({ ROOTKEY_API_URL: URL_ })).warnings).toEqual([]);
      expect(loadConfig(env()).warnings).toEqual([]);
    });

    it('still validates the URL: plain http off loopback is refused', () => {
      expect(() => loadConfig(env({ ROOTKEY_ENV: 'development', ROOTKEY_API_URL: 'http://onprem.example/api-v1' }))).toThrow(
        /unencrypted/,
      );
    });

    it('still rejects a garbage ROOTKEY_ENV as 0.1.0 did, URL or not', () => {
      expect(() => loadConfig(env({ ROOTKEY_ENV: 'staging', ROOTKEY_API_URL: URL_ }))).toThrow(ConfigError);
    });
  });

  it('still refuses ROOTKEY_ENV=development when there is no ROOTKEY_API_URL', () => {
    expect(() => loadConfig(env({ ROOTKEY_ENV: 'development' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ ROOTKEY_ENV: 'development', ROOTKEY_API_URL: '   ' }))).toThrow(ConfigError);
  });

  it.each(['production', 'PRODUCTION', '  Production  ', '', '   '])(
    'resolves ROOTKEY_ENV=%j to the production API',
    (value) => {
      const config = loadConfig(env({ ROOTKEY_ENV: value }));
      expect(config.baseUrl).toBe('https://api.rootkey.ai/api-v1/');
      expect(config.baseUrl).toBe(PRODUCTION_BASE_URL);
      expect(config.environment).toBe('production');
    },
  );

  it('resolves an unset ROOTKEY_ENV to the production API', () => {
    const config = loadConfig(env());
    expect(config.baseUrl).toBe('https://api.rootkey.ai/api-v1/');
    expect(config.environment).toBe('production');
  });

  it('does not export a development base URL', async () => {
    const mod = (await import('../src/config.js')) as Record<string, unknown>;
    expect(mod).not.toHaveProperty('DEVELOPMENT_BASE_URL');
    expect(Object.values(mod).filter((v) => typeof v === 'string' && /dev-api/i.test(v))).toEqual([]);
  });

  it('lets ROOTKEY_API_URL point at a self-hosted deployment and reports it as custom', () => {
    const config = loadConfig(env({ ROOTKEY_ENV: 'production', ROOTKEY_API_URL: 'https://staging.example/api-v1' }));
    expect(config.baseUrl).toBe('https://staging.example/api-v1/');
    expect(config.environment).toBe('custom');
  });

  it('reports ROOTKEY_API_URL set to the public API as production', () => {
    const config = loadConfig(env({ ROOTKEY_API_URL: 'https://api.rootkey.ai/api-v1' }));
    expect(config.environment).toBe('production');
  });

  it('still refuses plain http off loopback through ROOTKEY_API_URL, and allows loopback', () => {
    expect(() => loadConfig(env({ ROOTKEY_API_URL: 'http://onprem.example/api-v1' }))).toThrow(/unencrypted/);
    expect(loadConfig(env({ ROOTKEY_API_URL: 'http://localhost:3333/api-v1' })).environment).toBe('custom');
  });

  it.each(['staging', 'dev', 'prod', 'test', 'custom'])('rejects the unknown ROOTKEY_ENV %j', (value) => {
    let error: unknown;
    try {
      loadConfig(env({ ROOTKEY_ENV: value }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toMatch(/production/);
    // The error must not advertise "development" as an accepted value.
    expect(message).not.toMatch(/"production" or "development"/);
    expect(message).not.toMatch(/dev-api/i);
  });

  it('parses booleans and timeouts', () => {
    const config = loadConfig(env({ ROOTKEY_READ_ONLY: 'TRUE', ROOTKEY_TIMEOUT_MS: '5000' }));
    expect(config.readOnly).toBe(true);
    expect(config.timeoutMs).toBe(5000);
  });

  it('rejects a non-numeric timeout', () => {
    expect(() => loadConfig(env({ ROOTKEY_TIMEOUT_MS: 'soon' }))).toThrow(ConfigError);
  });

  it('rejects an invalid log level', () => {
    expect(() => loadConfig(env({ ROOTKEY_LOG_LEVEL: 'chatty' }))).toThrow(ConfigError);
  });
});

describe('normalizeBaseUrl', () => {
  it('always appends a trailing slash so the /api-v1 prefix survives path joining', () => {
    expect(normalizeBaseUrl('https://api.rootkey.ai/api-v1')).toBe('https://api.rootkey.ai/api-v1/');
    expect(normalizeBaseUrl('https://api.rootkey.ai/api-v1/')).toBe('https://api.rootkey.ai/api-v1/');
  });

  it('drops any query or fragment', () => {
    expect(normalizeBaseUrl('https://api.rootkey.ai/api-v1?debug=1#x')).toBe('https://api.rootkey.ai/api-v1/');
  });

  // The API key rides in a header on every request, so plain http would put it on the wire in clear.
  it('rejects plain http for a remote host but allows it on loopback', () => {
    expect(() => normalizeBaseUrl('http://api.rootkey.ai/api-v1')).toThrow(/unencrypted/);
    expect(() => normalizeBaseUrl('http://192.168.1.10:3333/api-v1')).toThrow(/unencrypted/);

    expect(normalizeBaseUrl('http://localhost:3333/api-v1')).toBe('http://localhost:3333/api-v1/');
    expect(normalizeBaseUrl('http://127.0.0.1:3333/api-v1')).toBe('http://127.0.0.1:3333/api-v1/');
    expect(normalizeBaseUrl('http://[::1]:3333/api-v1')).toBe('http://[::1]:3333/api-v1/');
  });

  it('rejects values that are not absolute http(s) URLs', () => {
    expect(() => normalizeBaseUrl('api.rootkey.ai')).toThrow(ConfigError);
    expect(() => normalizeBaseUrl('ftp://api.rootkey.ai')).toThrow(ConfigError);
  });
});

describe('keyMode', () => {
  it('classifies keys by prefix only', () => {
    expect(keyMode('rk_live_secret')).toBe('live');
    expect(keyMode('rk_test_secret')).toBe('test');
    expect(keyMode('legacy-key')).toBe('unknown');
  });

  // Existing keys are unprefixed UUIDs, so the prefix is not a reliable environment signal.
  it('reports an unprefixed UUID key as unknown rather than guessing', () => {
    expect(keyMode('3f2b8c1e-9d4a-4e7b-8a61-5c0d2e7f9a10')).toBe('unknown');
  });
});

describe('version', () => {
  it('matches the version in package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(SERVER_VERSION).toBe('0.1.1');
  });
});
