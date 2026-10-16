import { LOG_LEVELS, type LogLevel } from './log.js';
import { defaultAllowedRoots, parseAllowedRoots } from './paths.js';

export const PRODUCTION_BASE_URL = 'https://api.rootkey.ai/api-v1/';

export type Environment = 'production' | 'custom';
export type KeyMode = 'live' | 'test' | 'unknown';

/**
 * What the server authenticates with. A personal access token is the user's own delegated credential
 * and is sent as a Bearer token; an organization API key is the 0.1.x credential, sent as `x-api-key`.
 */
export type Credential = { kind: 'pat'; token: string } | { kind: 'api_key'; apiKey: string };

export type CredentialKind = Credential['kind'];

/** `rk_pat_` followed by 32 random bytes in hex: the only shape the API issues. */
const PAT_PATTERN = /^rk_pat_[0-9a-f]{64}$/;
/** Ids are opaque to this server but end up in a header, so only characters that cannot break one. */
const ORGANIZATION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export const ORGANIZATION_ID_HINT =
  'an organization id: letters, digits, dots, dashes and underscores only (rootkey_list_organizations returns them)';

/** Whether `value` is usable as an organization id in the `X-RootKey-Organization` header. */
export function isValidOrganizationId(value: string): boolean {
  return ORGANIZATION_ID_PATTERN.test(value);
}

export interface Config {
  credential: Credential;
  /** Default organization for a personal access token. A tool's own `organization` argument overrides it. */
  organization: string | undefined;
  /**
   * Which data set a personal access token works on, sent as `x-test-mode`. Undefined sends nothing and
   * the API answers with live data. Organization API keys ignore it: their prefix and row decide.
   */
  testMode: boolean | undefined;
  /** Always ends with a slash so relative paths join without dropping the /api-v1 prefix. */
  baseUrl: string;
  environment: Environment;
  readOnly: boolean;
  timeoutMs: number;
  transferTimeoutMs: number;
  downloadDir: string | undefined;
  /** Absolute roots that rootkey_upload_file, rootkey_upload_file_version and rootkey_validate_file may read from. */
  allowedRoots: string[];
  logLevel: LogLevel;
  /** Non-fatal notices about the environment, for the caller to print once the log level is known. */
  warnings: string[];
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 300_000;

// Config errors never echo the value they reject: a secret pasted into the wrong variable would otherwise be
// printed into the client's log. They say which variable and what shape it needs.
function parseBoolean(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new ConfigError(`${name} must be true or false.`);
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive number of milliseconds.`);
  }
  return Math.floor(value);
}

/** Guarantees a trailing slash: `new URL('platform/files', base)` must keep the /api-v1 segment. */
export function normalizeBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError('ROOTKEY_API_URL is not a valid absolute URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`ROOTKEY_API_URL must be http or https, got "${parsed.protocol}".`);
  }
  // Every request carries the credential in a header. Plain http puts it on the wire in clear, so it is
  // allowed only where the wire does not leave the machine.
  if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
    throw new ConfigError(
      `ROOTKEY_API_URL uses plain http for "${parsed.hostname}", which would send your credential ` +
        'unencrypted. Use https, or point at localhost if you are running the API on this machine.',
    );
  }
  parsed.search = '';
  parsed.hash = '';
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed.toString();
}

/**
 * Where plain http is acceptable because the bytes never leave the machine: the name `localhost`, an IPv4
 * address in 127.0.0.0/8 and `::1`. Not `*.localhost`: that is loopback only on resolvers that implement
 * RFC 6761, and a credential must not depend on which resolver the machine happens to use.
 */
export function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function resolveEnvironment(baseUrl: string): Environment {
  if (baseUrl === PRODUCTION_BASE_URL) return 'production';
  return 'custom';
}

/** Derived from the key prefix alone - no key characters are ever exposed. */
export function keyMode(apiKey: string): KeyMode {
  if (apiKey.startsWith('rk_live_')) return 'live';
  if (apiKey.startsWith('rk_test_')) return 'test';
  return 'unknown';
}

function resolveCredential(env: NodeJS.ProcessEnv, warnings: string[]): Credential {
  const token = env.ROOTKEY_TOKEN?.trim();
  const apiKey = env.ROOTKEY_API_KEY?.trim();

  if (token && apiKey) {
    throw new ConfigError(
      'Both ROOTKEY_TOKEN and ROOTKEY_API_KEY are set. Set only one: ROOTKEY_TOKEN (a personal access token) ' +
        'is the supported credential; ROOTKEY_API_KEY is the deprecated organization API key.',
    );
  }

  if (token) {
    // The value is never echoed: a malformed token is still somebody's secret.
    if (!PAT_PATTERN.test(token)) {
      throw new ConfigError(
        'ROOTKEY_TOKEN is not a valid personal access token. It must start with "rk_pat_" and be followed by ' +
          '64 hexadecimal characters. Create one in the ROOTKey dashboard under Settings -> Personal access tokens ' +
          'and paste it whole.',
      );
    }
    return { kind: 'pat', token };
  }

  if (apiKey) {
    if (apiKey.startsWith('rk_pat_')) {
      throw new ConfigError(
        'ROOTKEY_API_KEY holds a personal access token (it starts with "rk_pat_"). Personal access tokens go ' +
          'in ROOTKEY_TOKEN; ROOTKEY_API_KEY is only for the deprecated organization API keys.',
      );
    }
    warnings.push(
      'ROOTKEY_API_KEY is set: org API keys are deprecated, removed in 0.3.0; use a personal access token ' +
        '(ROOTKEY_TOKEN, created under Settings -> Personal access tokens).',
    );
    return { kind: 'api_key', apiKey };
  }

  throw new ConfigError(
    'No credential is set. Create a personal access token in the ROOTKey dashboard under ' +
      'Settings -> Personal access tokens, then pass it to the server as the ROOTKEY_TOKEN environment ' +
      'variable. (ROOTKEY_API_KEY, the deprecated organization API key from Developer Tools -> API Keys, ' +
      'is still accepted until 0.3.0.)',
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const warnings: string[] = [];
  const credential = resolveCredential(env, warnings);

  let organization: string | undefined;
  let testMode: boolean | undefined;
  const rawOrganization = env.ROOTKEY_ORGANIZATION?.trim() || undefined;
  const rawTestMode = env.ROOTKEY_TEST_MODE?.trim() || undefined;

  if (credential.kind === 'pat') {
    if (rawOrganization !== undefined && !ORGANIZATION_ID_PATTERN.test(rawOrganization)) {
      throw new ConfigError(`ROOTKEY_ORGANIZATION must be ${ORGANIZATION_ID_HINT}.`);
    }
    organization = rawOrganization;
    testMode = rawTestMode === undefined ? undefined : parseBoolean(rawTestMode, false, 'ROOTKEY_TEST_MODE');
  } else {
    // These two only mean something for a personal access token, and a 0.1.x setup may export them for another
    // tool with any value at all: they are neither validated nor allowed to stop a start-up that used to work.
    // Staying silent would let someone believe they are in effect, so they earn a warning.
    if (rawOrganization !== undefined) {
      warnings.push('ROOTKEY_ORGANIZATION is ignored with an organization API key: the key is bound to one organization.');
    }
    if (rawTestMode !== undefined) {
      warnings.push(
        'ROOTKEY_TEST_MODE is ignored with an organization API key: the key itself decides between test and live data.',
      );
    }
  }

  const explicitUrl = env.ROOTKEY_API_URL?.trim();
  const requestedEnv = env.ROOTKEY_ENV?.trim().toLowerCase();
  if (requestedEnv === 'development' && explicitUrl) {
    // 0.1.0 documented ROOTKEY_API_URL as overriding ROOTKEY_ENV, so a self-hosted setup may carry both.
    // The URL is used exactly as before; the stale variable only earns a notice, not a startup failure.
    warnings.push(
      'ROOTKEY_ENV is set to a value that is obsolete (there is no public development environment) and is ' +
        'ignored because ROOTKEY_API_URL is set; you can remove ROOTKEY_ENV.',
    );
  } else if (requestedEnv === 'development') {
    // 0.1.0 accepted this and pointed at a host that does not exist, so people may still have it set.
    // Fail loudly with the real alternatives rather than ignoring it.
    throw new ConfigError(
      'ROOTKEY_ENV: there is no public development environment. ROOTKey has one public API, the production API ' +
        `(${PRODUCTION_BASE_URL}); a test key works against it and keeps its data separate from live data, ` +
        'so remove ROOTKEY_ENV (keep ROOTKEY_API_URL if you set it for a self-hosted or on-prem deployment).',
    );
  }
  if (requestedEnv && requestedEnv !== 'production' && requestedEnv !== 'development') {
    throw new ConfigError(
      'ROOTKEY_ENV must be "production" (or left unset). ' +
        'For a self-hosted or on-prem deployment, set ROOTKEY_API_URL instead.',
    );
  }

  const baseUrl = explicitUrl ? normalizeBaseUrl(explicitUrl) : PRODUCTION_BASE_URL;

  const rawLogLevel = env.ROOTKEY_LOG_LEVEL?.trim().toLowerCase();
  if (rawLogLevel && !LOG_LEVELS.includes(rawLogLevel as LogLevel)) {
    throw new ConfigError(`ROOTKEY_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}.`);
  }

  const downloadDir = env.ROOTKEY_DOWNLOAD_DIR?.trim();

  return {
    credential,
    organization,
    testMode,
    baseUrl,
    environment: resolveEnvironment(baseUrl),
    readOnly: parseBoolean(env.ROOTKEY_READ_ONLY, false, 'ROOTKEY_READ_ONLY'),
    timeoutMs: parsePositiveInt(env.ROOTKEY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'ROOTKEY_TIMEOUT_MS'),
    transferTimeoutMs: parsePositiveInt(
      env.ROOTKEY_TRANSFER_TIMEOUT_MS,
      DEFAULT_TRANSFER_TIMEOUT_MS,
      'ROOTKEY_TRANSFER_TIMEOUT_MS',
    ),
    downloadDir: downloadDir && downloadDir.length > 0 ? downloadDir : undefined,
    allowedRoots: parseAllowedRoots(env.ROOTKEY_ALLOWED_DIRS) ?? defaultAllowedRoots(),
    logLevel: (rawLogLevel as LogLevel | undefined) ?? 'info',
    warnings,
  };
}
