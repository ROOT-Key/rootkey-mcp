import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEVELOPMENT_BASE_URL,
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

  it('switches to development when ROOTKEY_ENV asks for it', () => {
    const config = loadConfig(env({ ROOTKEY_ENV: 'development' }));
    expect(config.baseUrl).toBe(DEVELOPMENT_BASE_URL);
    expect(config.environment).toBe('development');
  });

  it('lets ROOTKEY_API_URL win over ROOTKEY_ENV', () => {
    const config = loadConfig(env({ ROOTKEY_ENV: 'development', ROOTKEY_API_URL: 'https://staging.example/api-v1' }));
    expect(config.baseUrl).toBe('https://staging.example/api-v1/');
    expect(config.environment).toBe('custom');
  });

  it('rejects an unknown ROOTKEY_ENV', () => {
    expect(() => loadConfig(env({ ROOTKEY_ENV: 'staging' }))).toThrow(/production/);
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
});

describe('version', () => {
  it('matches the version in package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
