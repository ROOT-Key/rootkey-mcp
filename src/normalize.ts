/**
 * The API wraps paginated collections in five different envelopes:
 *   { chainId, files:  { data, pagination, metadata } }        list files
 *   { chainId, records:{ data, pagination, metadata } }        list records
 *   { data, pagination, metadata }                             list versions (bare)
 *   { chainId, history:{ data, pagination, metadata } }         history
 *   { currentHash, previousHash, validations: { data, ... } }   validations
 *
 * Tools return one shape instead, keeping any extra top-level fields (chainId, currentHash,
 * previousHash) alongside it so nothing the API said is lost.
 */
export interface NormalizedPage {
  items: unknown[];
  pagination: { nextCursor: string | null; previousCursor: string | null };
  metadata?: unknown;
  [extra: string]: unknown;
}

interface RawPage {
  data: unknown[];
  pagination?: { nextCursor?: unknown; previousCursor?: unknown } | null;
  metadata?: unknown;
}

function isRawPage(value: unknown): value is RawPage {
  return typeof value === 'object' && value !== null && Array.isArray((value as { data?: unknown }).data);
}

function asCursor(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function normalizePage(payload: unknown): NormalizedPage {
  if (isRawPage(payload)) return buildPage(payload, {});

  if (typeof payload === 'object' && payload !== null) {
    const entries = Object.entries(payload as Record<string, unknown>);
    const pageEntry = entries.find(([, value]) => isRawPage(value));
    if (pageEntry) {
      const extras = Object.fromEntries(entries.filter(([key]) => key !== pageEntry[0]));
      return buildPage(pageEntry[1] as RawPage, extras);
    }
  }

  // Unpaginated or unexpected shape: surface it rather than silently dropping it.
  return { items: [], pagination: { nextCursor: null, previousCursor: null }, raw: payload };
}

function buildPage(page: RawPage, extras: Record<string, unknown>): NormalizedPage {
  const result: NormalizedPage = {
    ...extras,
    items: page.data,
    pagination: {
      nextCursor: asCursor(page.pagination?.nextCursor),
      previousCursor: asCursor(page.pagination?.previousCursor),
    },
  };
  if (page.metadata !== undefined) result.metadata = page.metadata;
  return result;
}

/**
 * Unwraps a single-key envelope such as `{ recoveryPoint: {...} }` or `{ recoveryPoints: [...] }`,
 * returning the inner value when the key matches and the whole payload otherwise.
 */
export function unwrap(payload: unknown, key: string): unknown {
  if (typeof payload === 'object' && payload !== null && key in (payload as Record<string, unknown>)) {
    return (payload as Record<string, unknown>)[key];
  }
  return payload;
}
