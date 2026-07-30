/**
 * stdout belongs to the stdio JSON-RPC transport. Anything written there that is not a
 * protocol message corrupts the session, so every log line goes to stderr.
 */
export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function write(level: Exclude<LogLevel, 'silent'>, message: string): void {
  if (RANK[currentLevel] < RANK[level]) return;
  process.stderr.write(`[rootkey-mcp] ${level}: ${message}\n`);
}

export const log = {
  error: (message: string) => write('error', message),
  warn: (message: string) => write('warn', message),
  info: (message: string) => write('info', message),
  debug: (message: string) => write('debug', message),
};
