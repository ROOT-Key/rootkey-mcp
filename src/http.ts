import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from './config.js';
import { ApiError, NetworkError, apiErrorFromBody } from './errors.js';
import { log } from './log.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  method: HttpMethod;
  /** Relative to the base URL and never starting with "/" - a leading slash drops the /api-v1 prefix. */
  path: string;
  query?: Record<string, QueryValue>;
  /** JSON request body. Mutually exclusive with `form`. */
  body?: unknown;
  /** Multipart body. The runtime sets content-type (with the boundary), so we never do. */
  form?: FormData;
  /** `binary` returns the raw Response for streaming; `json` parses the body. */
  responseType?: 'json' | 'binary';
  /** Suppresses response-body logging for endpoints that return secrets. */
  sensitive?: boolean;
  /** Per-call cancellation from the MCP client. */
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}

const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 30_000;
/**
 * A retried POST could anchor the same file or record twice, and anchoring is irreversible.
 * Only methods that are safe to repeat are retried on transport-level failures.
 */
const REPEATABLE_METHODS = new Set<HttpMethod>(['GET', 'PUT', 'DELETE']);
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_REDIRECTS = 5;

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export class RootKeyClient {
  constructor(private readonly config: Config) {}

  buildUrl(path: string, query?: Record<string, QueryValue>): URL {
    if (path.startsWith('/')) {
      throw new Error(`Internal error: request path must be relative, got "${path}".`);
    }
    const url = new URL(path, this.config.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  /** Performs the request and parses JSON. */
  async request<T = unknown>(options: RequestOptions): Promise<T> {
    const response = await this.send(options);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (text.trim() === '') return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError({
        status: response.status,
        message: `Expected JSON from ${options.method} ${options.path} but received: ${text.slice(0, 200)}`,
      });
    }
  }

  /** Performs the request and hands back the Response so the body can be streamed to disk. */
  async requestBinary(options: RequestOptions): Promise<Response> {
    return this.send({ ...options, responseType: 'binary' });
  }

  private async send(options: RequestOptions): Promise<Response> {
    const url = this.buildUrl(options.path, options.query);
    const isTransfer = options.responseType === 'binary' || options.form !== undefined;
    const timeoutMs = options.timeoutMs ?? (isTransfer ? this.config.transferTimeoutMs : this.config.timeoutMs);

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

      let response: Response;
      try {
        log.debug(`${options.method} ${url.pathname}${url.search} (attempt ${attempt})`);
        response = await this.fetchFollowingRedirects(url, options, signal);
      } catch (cause) {
        lastError = toTransportError(cause, url, options.signal, timeoutMs);
        if (attempt < MAX_ATTEMPTS && REPEATABLE_METHODS.has(options.method) && !isAbortedByCaller(options.signal)) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      if (response.ok) return response;

      const shouldRetry =
        attempt < MAX_ATTEMPTS &&
        (response.status === 429 || (RETRYABLE_STATUSES.has(response.status) && REPEATABLE_METHODS.has(options.method)));

      if (!shouldRetry) throw await toApiError(response, options.sensitive === true);

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) {
        throw await toApiError(response, options.sensitive === true);
      }
      const waitMs = retryAfterMs ?? backoffMs(attempt);
      log.warn(`HTTP ${response.status} from ${options.path}; retrying in ${waitMs}ms`);
      await response.body?.cancel().catch(() => undefined);
      await sleep(waitMs);
    }

    throw lastError ?? new NetworkError(`Request to ${url.toString()} failed after ${MAX_ATTEMPTS} attempts.`);
  }

  /**
   * `redirect: 'manual'` plus an explicit walk, so a hop to another origin drops the API key.
   *
   * The runtime's automatic redirect following strips `Authorization` across origins but knows nothing
   * about `x-api-key`, so it would forward the credential to whatever host the Location names. The
   * download endpoint streams today rather than redirecting to a signed URL, but the day it changes
   * the key must not be the thing that goes along for the ride.
   */
  private async fetchFollowingRedirects(
    url: URL,
    options: RequestOptions,
    signal: AbortSignal,
  ): Promise<Response> {
    let target = url;
    let carryCredentials = true;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetch(target, {
        method: options.method,
        headers: this.buildHeaders(options, carryCredentials),
        body: hop === 0 ? this.buildBody(options) : undefined,
        redirect: 'manual',
        signal,
      });

      if (!isRedirect(response.status)) return response;

      const location = response.headers.get('location');
      if (!location) return response;

      const next = new URL(location, target);
      await response.body?.cancel().catch(() => undefined);

      if (next.origin !== target.origin) {
        log.debug(`redirect to ${next.origin}: continuing without the API key`);
        carryCredentials = false;
      }
      target = next;
    }

    throw new NetworkError(`Too many redirects following ${url.pathname} (limit ${MAX_REDIRECTS}).`);
  }

  private buildHeaders(options: RequestOptions, carryCredentials = true): Record<string, string> {
    const headers: Record<string, string> = {
      accept: options.responseType === 'binary' ? '*/*' : 'application/json',
    };
    if (carryCredentials) headers['x-api-key'] = this.config.apiKey;
    // Multipart must not carry an explicit content-type: fetch generates the boundary.
    if (options.body !== undefined && options.form === undefined) {
      headers['content-type'] = 'application/json';
    }
    return headers;
  }

  private buildBody(options: RequestOptions): FormData | string | undefined {
    if (options.form !== undefined) return options.form;
    if (options.body !== undefined) return JSON.stringify(options.body);
    return undefined;
  }
}

async function toApiError(response: Response, sensitive: boolean): Promise<ApiError> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }
  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const error = apiErrorFromBody(response.status, parsed, text);
  log.debug(sensitive ? `request failed with HTTP ${response.status}` : `request failed: ${error.toDisplayString()}`);
  return error;
}

function toTransportError(cause: unknown, url: URL, callerSignal: AbortSignal | undefined, timeoutMs: number): Error {
  if (isAbortedByCaller(callerSignal)) {
    return new NetworkError('The request was cancelled by the client.');
  }
  if (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
    return new NetworkError(
      `Request to ${url.origin} timed out after ${timeoutMs}ms. Raise ROOTKEY_TIMEOUT_MS ` +
        '(or ROOTKEY_TRANSFER_TIMEOUT_MS for uploads and downloads) if this is expected.',
    );
  }
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new NetworkError(`Could not reach ${url.origin}: ${reason}`);
}

function isAbortedByCaller(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Full jitter over an exponential base, so parallel tools do not retry in lockstep. */
function backoffMs(attempt: number): number {
  const ceiling = 1000 * 2 ** (attempt - 1);
  return Math.floor(Math.random() * ceiling) + 100;
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}
