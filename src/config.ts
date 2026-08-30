import { LOG_LEVELS, type LogLevel } from './log.js';
import { defaultAllowedRoots, parseAllowedRoots } from './paths.js';

export const PRODUCTION_BASE_URL = 'https://api.rootkey.ai/api-v1/';
export const DEVELOPMENT_BASE_URL = 'https://dev-api.rootkey.ai/api-v1/';

export type Environment = 'production' | 'development' | 'custom';
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
  /** Absolute roots that upload_file, upload_file_version and validate_file may read from. */
  allowedRoots: string[];
  logLevel: LogLevel;
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
  parsed.search = '';
  parsed.hash = '';
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed.toString();
}

function resolveEnvironment(baseUrl: string): Environment {
  if (baseUrl === PRODUCTION_BASE_URL) return 'production';
  if (baseUrl === DEVELOPMENT_BASE_URL) return 'development';
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
        'Platform -> Developer Tools -> API Keys, then pass it to the server as the ' +
        'ROOTKEY_API_KEY environment variable.',
    );
  }

  const explicitUrl = env.ROOTKEY_API_URL?.trim();
  const requestedEnv = env.ROOTKEY_ENV?.trim().toLowerCase();
  if (requestedEnv && !['production', 'development'].includes(requestedEnv)) {
    throw new ConfigError(`ROOTKEY_ENV must be "production" or "development", got "${requestedEnv}".`);
  }

  const baseUrl = explicitUrl
    ? normalizeBaseUrl(explicitUrl)
    : requestedEnv === 'development'
      ? DEVELOPMENT_BASE_URL
      : PRODUCTION_BASE_URL;

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
  };
}
