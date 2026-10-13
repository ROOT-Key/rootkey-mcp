import { LOG_LEVELS, type LogLevel } from './log.js';
import { defaultAllowedRoots, parseAllowedRoots } from './paths.js';

export const PRODUCTION_BASE_URL = 'https://api.rootkey.ai/api-v1/';

export type Environment = 'production' | 'custom';
export type KeyMode = 'live' | 'test' | 'unknown';

export interface Config {
  apiKey: string;
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

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new ConfigError(`Expected a boolean value but got "${raw}". Use true or false.`);
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive number of milliseconds, got "${raw}".`);
  }
  return Math.floor(value);
}

/** Guarantees a trailing slash: `new URL('platform/files', base)` must keep the /api-v1 segment. */
export function normalizeBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`ROOTKEY_API_URL is not a valid absolute URL: "${raw}".`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`ROOTKEY_API_URL must be http or https, got "${parsed.protocol}".`);
  }
  // Every request carries the API key in a header. Plain http puts it on the wire in clear, so it is
  // allowed only where the wire does not leave the machine.
  if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
    throw new ConfigError(
      `ROOTKEY_API_URL uses plain http for "${parsed.hostname}", which would send your API key ` +
        'unencrypted. Use https, or point at localhost if you are running the API on this machine.',
    );
  }
  parsed.search = '';
  parsed.hash = '';
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed.toString();
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.ROOTKEY_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError(
      'ROOTKEY_API_KEY is not set. Create an API key in the ROOTKey dashboard under ' +
        'Developer Tools -> API Keys, then pass it to the server as the ' +
        'ROOTKEY_API_KEY environment variable.',
    );
  }

  const explicitUrl = env.ROOTKEY_API_URL?.trim();
  const requestedEnv = env.ROOTKEY_ENV?.trim().toLowerCase();
  const warnings: string[] = [];
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
      `ROOTKEY_ENV must be "production" (or left unset), got "${requestedEnv}". ` +
        'For a self-hosted or on-prem deployment, set ROOTKEY_API_URL instead.',
    );
  }

  const baseUrl = explicitUrl ? normalizeBaseUrl(explicitUrl) : PRODUCTION_BASE_URL;

  const rawLogLevel = env.ROOTKEY_LOG_LEVEL?.trim().toLowerCase();
  if (rawLogLevel && !LOG_LEVELS.includes(rawLogLevel as LogLevel)) {
    throw new ConfigError(`ROOTKEY_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${rawLogLevel}".`);
  }

  const downloadDir = env.ROOTKEY_DOWNLOAD_DIR?.trim();

  return {
    apiKey,
    baseUrl,
    environment: resolveEnvironment(baseUrl),
    readOnly: parseBoolean(env.ROOTKEY_READ_ONLY, false),
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
