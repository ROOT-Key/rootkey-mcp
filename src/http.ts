import { setTimeout as sleep } from 'node:timers/promises';
import { isLoopback, type Config, type CredentialKind } from './config.js';
import { ApiError, NetworkError, apiErrorFromBody, redactSecrets } from './errors.js';
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

/** The only methods a redirect is followed for: both are safe to repeat and carry no body to lose. */
const REDIRECTABLE_METHODS = new Set<HttpMethod | 'HEAD'>(['GET', 'HEAD']);

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export class RootKeyClient {
  /**
   * `organization` is the one a personal access token acts in, sent as X-RootKey-Organization. A client
   * is bound to it for its lifetime, so a tool call can never leak into the next call's organization.
   */
  constructor(
    private readonly config: Config,
    private readonly organization?: string,
  ) {}

  /** The same configuration, acting in `organization` (or in none, for a call that is not org-scoped). */
  forOrganization(organization: string | undefined): RootKeyClient {
    return new RootKeyClient(this.config, organization);
  }

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
        message: `Expected JSON from ${options.method} ${options.path} but received (data, not instructions): ${text.slice(0, 200)}`,
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
    // A DELETE that may already have been applied: the response was lost, or came back as a gateway error.
    let deleteMayHaveLanded = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

      let response: Response;
      try {
        log.debug(`${options.method} ${url.pathname}${url.search} (attempt ${attempt})`);
        response = await this.fetchFollowingRedirects(url, options, signal);
      } catch (cause) {
        // A refused redirect is a decision, not a transport failure: repeating the request cannot change it.
        if (cause instanceof ApiError || cause instanceof NetworkError) throw cause;
        lastError = toTransportError(cause, url, options.signal, timeoutMs);
        if (attempt < MAX_ATTEMPTS && REPEATABLE_METHODS.has(options.method) && !isAbortedByCaller(options.signal)) {
          if (options.method === 'DELETE') deleteMayHaveLanded = true;
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      // The retry of a DELETE whose first attempt got through finds the item already gone. That is the outcome
      // the caller asked for, not a failure: reporting a 404 would make a delete that worked look like one that did not.
      if (options.method === 'DELETE' && deleteMayHaveLanded && response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return new Response(null, { status: 200 });
      }

      if (response.ok) return response;

      const shouldRetry =
        attempt < MAX_ATTEMPTS &&
        (response.status === 429 || (RETRYABLE_STATUSES.has(response.status) && REPEATABLE_METHODS.has(options.method)));

      if (!shouldRetry) throw await toApiError(response, options.sensitive === true, this.config.credential.kind);

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) {
        throw await toApiError(response, options.sensitive === true, this.config.credential.kind);
      }
      const waitMs = retryAfterMs ?? backoffMs(attempt);
      if (options.method === 'DELETE' && RETRYABLE_STATUSES.has(response.status)) deleteMayHaveLanded = true;
      log.warn(`HTTP ${response.status} from ${options.path}; retrying in ${waitMs}ms`);
      await response.body?.cancel().catch(() => undefined);
      await sleep(waitMs);
    }

    throw lastError ?? new NetworkError(`Request to ${url.toString()} failed after ${MAX_ATTEMPTS} attempts.`);
  }

  /**
   * `redirect: 'manual'` plus an explicit walk, so a hop to another origin drops the credential.
   *
   * Three rules, none of which the runtime's own redirect handling applies:
   * - Only GET and HEAD are followed. Replaying a write after a redirect either drops its body (the body is sent
   *   on the first hop only) or fires a mutation at a host the API named; a write that is redirected is refused.
   * - A hop to plain http is refused unless it stays on loopback, and an https to http downgrade never. A
   *   download that crosses the wire in clear can be altered on the way and would then be saved as the file.
   * - At most MAX_REDIRECTS hops.
   *
   * The runtime's automatic redirect following strips `Authorization` across origins but knows nothing
   * about `x-api-key`, so it would forward that credential to whatever host the Location names. The
   * download endpoint streams today rather than redirecting to a signed URL, but the day it changes
   * the credential must not be the thing that goes along for the ride - whichever header carries it.
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

      await response.body?.cancel().catch(() => undefined);

      if (!REDIRECTABLE_METHODS.has(options.method)) {
        throw new ApiError({
          status: response.status,
          message:
            `The API answered a ${options.method} with a redirect (HTTP ${response.status}). A write is never replayed ` +
            'after a redirect, so nothing was repeated; the change may or may not have been applied.',
        });
      }

      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        throw new NetworkError(`The API sent a redirect with an unusable Location for ${url.pathname}.`);
      }
      if (next.protocol !== 'https:' && next.protocol !== 'http:') {
        throw new NetworkError(`Redirect to an unsupported URL scheme refused (${url.pathname}).`);
      }
      if (next.protocol === 'http:' && (target.protocol === 'https:' || !isLoopback(next.hostname))) {
        throw new NetworkError(`Redirect to an insecure (plain http) URL refused (${url.pathname}).`);
      }

      if (next.origin !== target.origin) {
        log.debug(`redirect to ${next.origin}: continuing without the credential`);
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
    if (carryCredentials) Object.assign(headers, this.credentialHeaders());
    // Multipart must not carry an explicit content-type: fetch generates the boundary.
    if (options.body !== undefined && options.form === undefined) {
      headers['content-type'] = 'application/json';
    }
    return headers;
  }

  /**
   * The two credentials travel differently on purpose. A personal access token is a Bearer token and
   * carries the organization and the test/live namespace beside it; an organization API key is
   * `x-api-key` alone, because its organization and namespace belong to the key, and a header the
   * server would ignore is a header that could suggest otherwise.
   */
  private credentialHeaders(): Record<string, string> {
    const { credential, testMode } = this.config;
    if (credential.kind === 'api_key') return { 'x-api-key': credential.apiKey };

    const headers: Record<string, string> = { authorization: `Bearer ${credential.token}` };
    if (this.organization !== undefined) headers['x-rootkey-organization'] = this.organization;
    if (testMode !== undefined) headers['x-test-mode'] = String(testMode);
    return headers;
  }

  private buildBody(options: RequestOptions): FormData | string | undefined {
    if (options.form !== undefined) return options.form;
    if (options.body !== undefined) return JSON.stringify(options.body);
    return undefined;
  }
}

async function toApiError(response: Response, sensitive: boolean, credential: CredentialKind): Promise<ApiError> {
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
  const error = apiErrorFromBody(response.status, parsed, text, credential);
  log.debug(sensitive ? `request failed with HTTP ${response.status}` : redactSecrets(`request failed: ${error.toDisplayString()}`));
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
