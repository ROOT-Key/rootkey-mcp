/**
 * The ROOTKey API error envelope, per api-reference/errors.mdx and the OpenAPI spec:
 * `{ error: { requestId, message, errorCode, docUrl, timestamp } }`.
 * 401 responses carry no body at all, so every field is treated as optional.
 */
export interface ApiErrorDetails {
  status: number;
  errorCode?: string;
  message: string;
  requestId?: string;
  docUrl?: string;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly errorCode: string | undefined;
  readonly requestId: string | undefined;
  readonly docUrl: string | undefined;

  constructor(details: ApiErrorDetails) {
    super(details.message);
    this.status = details.status;
    this.errorCode = details.errorCode;
    this.requestId = details.requestId;
    this.docUrl = details.docUrl;
  }

  /** One line a human can act on, with the identifiers support will ask for. */
  toDisplayString(): string {
    const parts = [`ROOTKey API error ${this.status}`];
    if (this.errorCode) parts.push(`(${this.errorCode})`);
    parts.push(`- ${this.message}`);
    if (this.requestId) parts.push(`| requestId: ${this.requestId}`);
    if (this.docUrl) parts.push(`| docs: ${this.docUrl}`);
    return parts.join(' ');
  }
}

/** A caller mistake caught before or instead of a request (bad argument combination, missing file). */
export class ToolInputError extends Error {
  override readonly name = 'ToolInputError';
}

/** The request never reached the API (DNS, TLS, offline, timeout). */
export class NetworkError extends Error {
  override readonly name = 'NetworkError';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Builds an ApiError from a non-2xx response body. Falls back to written-out guidance for the
 * statuses the API returns without a usable body.
 */
export function apiErrorFromBody(status: number, body: unknown, rawText: string): ApiError {
  const envelope = asRecord(asRecord(body)?.error);

  const message =
    asString(envelope?.message) ??
    asString(asRecord(body)?.message) ??
    defaultMessageForStatus(status, rawText);

  return new ApiError({
    status,
    message,
    errorCode: asString(envelope?.errorCode),
    requestId: asString(envelope?.requestId),
    docUrl: asString(envelope?.docUrl),
  });
}

function defaultMessageForStatus(status: number, rawText: string): string {
  switch (status) {
    case 401:
      return (
        'Unauthenticated. Check that ROOTKEY_API_KEY holds a valid, active API key. There is one public ' +
        'ROOTKey API; the key decides whether you operate on test or live data.'
      );
    case 403:
      return (
        'Forbidden. This usually means your plan does not include the operation, a plan limit is ' +
        'exhausted, or the API key owner is not a member of the target organisation.'
      );
    case 404:
      return 'Not found. Check the identifier and the vault address you passed.';
    case 429:
      return 'Rate limit exceeded for this API key. Retry after the period indicated by the Retry-After header.';
    default: {
      const snippet = rawText.trim().slice(0, 300);
      return snippet.length > 0 ? snippet : `Request failed with HTTP ${status}.`;
    }
  }
}
