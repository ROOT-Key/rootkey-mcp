import { describe, expect, it } from 'vitest';
import { normalizePage, unwrap } from '../src/normalize.js';

const page = (data: unknown[]) => ({
  data,
  pagination: { previousCursor: null, nextCursor: '2026-07-30T00:00:00.000Z' },
  metadata: { fetchedCount: data.length, totalCount: 42 },
});

describe('normalizePage', () => {
  it('normalizes the list-files envelope and keeps chainId plus the aggregate metadata', () => {
    const result = normalizePage({
      chainId: 137,
      files: {
        ...page([{ id: 'f1' }]),
        metadata: { totalCount: 3, registered: 2, pending: 1, error: 0, totalSizeBytes: 999, last24hCount: 1 },
      },
    });

    expect(result.items).toEqual([{ id: 'f1' }]);
    expect(result.chainId).toBe(137);
    expect(result.pagination.nextCursor).toBe('2026-07-30T00:00:00.000Z');
    expect(result.metadata).toMatchObject({ registered: 2, pending: 1, totalSizeBytes: 999 });
  });

  it('normalizes the list-records envelope', () => {
    const result = normalizePage({ chainId: 137, records: page([{ __meta: { id: 'r1' } }]) });
    expect(result.items).toEqual([{ __meta: { id: 'r1' } }]);
    expect(result.chainId).toBe(137);
  });

  it('normalizes the bare versions envelope', () => {
    const result = normalizePage(page([{ id: 'v1' }, { id: 'v2' }]));
    expect(result.items).toHaveLength(2);
    expect(result.pagination.previousCursor).toBeNull();
  });

  it('normalizes the history envelope', () => {
    const result = normalizePage({ chainId: 137, history: page([{ action: 'download' }]) });
    expect(result.items).toEqual([{ action: 'download' }]);
  });

  it('normalizes the validations envelope and keeps both hashes', () => {
    const result = normalizePage({
      currentHash: '0xcurrent',
      previousHash: '0xprevious',
      validations: page([{ valid: true }]),
    });

    expect(result.items).toEqual([{ valid: true }]);
    expect(result.currentHash).toBe('0xcurrent');
    expect(result.previousHash).toBe('0xprevious');
    expect(result.chainId).toBeUndefined();
  });

  it('treats a missing cursor as null rather than undefined', () => {
    const result = normalizePage({ data: [], pagination: {} });
    expect(result.pagination).toEqual({ nextCursor: null, previousCursor: null });
  });

  it('surfaces an unexpected payload instead of dropping it', () => {
    const result = normalizePage({ unexpected: true });
    expect(result.items).toEqual([]);
    expect(result.raw).toEqual({ unexpected: true });
  });
});

describe('unwrap', () => {
  it('returns the inner value when the key is present', () => {
    expect(unwrap({ recoveryPoint: { id: 'rp1' } }, 'recoveryPoint')).toEqual({ id: 'rp1' });
  });

  it('returns the payload untouched when the key is absent', () => {
    expect(unwrap({ id: 'rp1' }, 'recoveryPoint')).toEqual({ id: 'rp1' });
  });
});
