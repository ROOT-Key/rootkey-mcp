import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from '../src/errors.js';
import { RootKeyClient, parseRetryAfter } from '../src/http.js';
import { stubFetch, testConfig } from './helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('URL building', () => {
  const client = new RootKeyClient(testConfig());

  it('keeps the /api-v1 prefix when joining a relative path', () => {
    expect(client.buildUrl('platform/files').toString()).toBe('https://api.rootkey.ai/api-v1/platform/files');
  });

  it('rejects a leading slash, which would silently drop /api-v1', () => {
    expect(() => client.buildUrl('/platform/files')).toThrow(/relative/);
  });

  it('appends query parameters and skips empty ones', () => {
    const url = client.buildUrl('platform/files', {
      vaultAddress: '0xabc',
      limit: 25,
      cursor: undefined,
      name: '',
      order: 'desc',
    });
    expect(url.searchParams.get('vaultAddress')).toBe('0xabc');
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.has('cursor')).toBe(false);
    expect(url.searchParams.has('name')).toBe(false);
    expect(url.searchParams.get('order')).toBe('desc');
  });

  it('honours a custom base URL that has no /api-v1 segment', () => {
    const custom = new RootKeyClient(testConfig({ baseUrl: 'https://staging.example/' }));
    expect(custom.buildUrl('platform/files').toString()).toBe('https://staging.example/platform/files');
  });
});

describe('headers', () => {
  it('sends the API key and a JSON content type for JSON bodies', async () => {
    const stub = stubFetch([{ json: { ok: true } }]);
    await new RootKeyClient(testConfig()).request({ method: 'POST', path: 'platform/vaults', body: { a: 1 } });

    expect(stub.calls[0]?.headers['x-api-key']).toBe('rk_test_unit');
    expect(stub.calls[0]?.headers['content-type']).toBe('application/json');
    expect(stub.calls[0]?.body).toBe('{"a":1}');
  });

  it('never sets content-type for multipart, so the runtime can add the boundary', async () => {
    const stub = stubFetch([{ json: { ok: true } }]);
    const form = new FormData();
    form.append('ownerVault', '0xabc');

    await new RootKeyClient(testConfig()).request({ method: 'POST', path: 'platform/files', form });

    expect(stub.calls[0]?.headers['content-type']).toBeUndefined();
    expect(stub.calls[0]?.body).toBeInstanceOf(FormData);
  });
});

describe('error mapping', () => {
  it('maps the API error envelope, including the request id and docs link', async () => {
    stubFetch([
      {
        status: 400,
        json: {
          error: {
            requestId: 'req-1',
            message: 'Vault address is invalid',
            errorCode: 'invalid_wallet_address',
            docUrl: 'https://docs.rootkey.ai/api-reference/errors',
            timestamp: '2026-07-30T00:00:00.000Z',
          },
        },
      },
    ]);

    const error = await new RootKeyClient(testConfig())
      .request({ method: 'GET', path: 'platform/files' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.errorCode).toBe('invalid_wallet_address');
    expect(apiError.toDisplayString()).toContain('req-1');
    expect(apiError.toDisplayString()).toContain('invalid_wallet_address');
  });

  it('writes out actionable guidance for a bodyless 401', async () => {
    stubFetch([{ status: 401, text: '' }]);

    const error = (await new RootKeyClient(testConfig())
      .request({ method: 'GET', path: 'platform/files' })
      .catch((e: unknown) => e)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain('ROOTKEY_API_KEY');
    expect(error.message).toContain('rk_test_');
  });

  it('explains a 403 on a plan-gated endpoint', async () => {
    stubFetch([{ status: 403, text: '' }]);
    const error = (await new RootKeyClient(testConfig())
      .request({ method: 'POST', path: 'platform/files/f1/audit-report' })
      .catch((e: unknown) => e)) as ApiError;

    expect(error.message).toMatch(/plan/i);
  });

  it('reports an unreachable host as a network error', async () => {
    stubFetch([{ networkError: new TypeError('fetch failed') }]);
    const error = await new RootKeyClient(testConfig())
      .request({ method: 'POST', path: 'platform/files' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toContain('https://api.rootkey.ai');
  });
});

describe('retries', () => {
  it('retries a 429 and honours Retry-After', async () => {
    const stub = stubFetch([
      { status: 429, headers: { 'retry-after': '0' }, text: '' },
      { json: { ok: true } },
    ]);

    const result = await new RootKeyClient(testConfig()).request({ method: 'GET', path: 'platform/files' });

    expect(result).toEqual({ ok: true });
    expect(stub.calls).toHaveLength(2);
  });

  it('gives up rather than waiting when Retry-After exceeds the cap', async () => {
    const stub = stubFetch([{ status: 429, headers: { 'retry-after': '600' }, text: '' }]);

    const error = (await new RootKeyClient(testConfig())
      .request({ method: 'GET', path: 'platform/files' })
      .catch((e: unknown) => e)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(429);
    expect(stub.calls).toHaveLength(1);
  });

  it('retries a 503 for a GET', async () => {
    const stub = stubFetch([{ status: 503, text: '' }, { json: { ok: true } }]);
    await new RootKeyClient(testConfig()).request({ method: 'GET', path: 'platform/files' });
    expect(stub.calls).toHaveLength(2);
  });

  it('never retries a POST after a 503, because a repeat could anchor twice', async () => {
    const stub = stubFetch([{ status: 503, text: '' }, { json: { ok: true } }]);

    await new RootKeyClient(testConfig())
      .request({ method: 'POST', path: 'platform/files' })
      .catch(() => undefined);

    expect(stub.calls).toHaveLength(1);
  });

  it('never retries a POST after a network failure either', async () => {
    const stub = stubFetch([{ networkError: new TypeError('socket hang up') }, { json: { ok: true } }]);

    await new RootKeyClient(testConfig())
      .request({ method: 'POST', path: 'platform/records' })
      .catch(() => undefined);

    expect(stub.calls).toHaveLength(1);
  });

  it('stops after three attempts', async () => {
    const stub = stubFetch([
      { status: 429, headers: { 'retry-after': '0' }, text: '' },
      { status: 429, headers: { 'retry-after': '0' }, text: '' },
      { status: 429, headers: { 'retry-after': '0' }, text: '' },
      { status: 429, headers: { 'retry-after': '0' }, text: '' },
    ]);

    await new RootKeyClient(testConfig())
      .request({ method: 'GET', path: 'platform/files' })
      .catch(() => undefined);

    expect(stub.calls).toHaveLength(3);
  });
});

describe('redirects', () => {
  it('follows a same-origin redirect and keeps sending the API key', async () => {
    const stub = stubFetch([
      { status: 302, headers: { location: '/api-v1/platform/files/f1/blob' } },
      { text: 'file-bytes' },
    ]);

    const response = await new RootKeyClient(testConfig()).requestBinary({ method: 'GET', path: 'platform/files/f1/download' });

    expect(await response.text()).toBe('file-bytes');
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1]!.url.pathname).toBe('/api-v1/platform/files/f1/blob');
    expect(stub.calls[1]!.headers['x-api-key']).toBe('rk_test_unit');
  });

  // The whole point: a signed-URL style hop must not carry the credential to the CDN.
  it('drops the API key when a redirect leaves the origin', async () => {
    const stub = stubFetch([
      { status: 302, headers: { location: 'https://cdn.example.net/signed/abc' } },
      { text: 'file-bytes' },
    ]);

    await new RootKeyClient(testConfig()).requestBinary({ method: 'GET', path: 'platform/files/f1/download' });

    expect(stub.calls[1]!.url.origin).toBe('https://cdn.example.net');
    expect(stub.calls[1]!.headers['x-api-key']).toBeUndefined();
    expect(JSON.stringify(stub.calls[1]!.headers)).not.toContain('rk_test_unit');
  });

  it('gives up rather than looping forever', async () => {
    stubFetch([{ status: 302, headers: { location: '/api-v1/loop' } }]);

    await expect(new RootKeyClient(testConfig()).request({ method: 'GET', path: 'platform/files' })).rejects.toThrow(
      /Too many redirects/,
    );
  });
});

describe('parseRetryAfter', () => {
  it('reads a delay in seconds', () => {
    expect(parseRetryAfter('2')).toBe(2000);
  });

  it('reads an HTTP date', () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const parsed = parseRetryAfter(future) ?? 0;
    expect(parsed).toBeGreaterThan(3000);
    expect(parsed).toBeLessThanOrEqual(6000);
  });

  it('ignores a missing or unparseable header', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('response parsing', () => {
  it('treats an empty 200 body as undefined rather than a parse error', async () => {
    stubFetch([{ status: 200, text: '' }]);
    const result = await new RootKeyClient(testConfig()).request({ method: 'DELETE', path: 'platform/vaults/0xabc' });
    expect(result).toBeUndefined();
  });

  it('fails clearly when the API returns non-JSON on success', async () => {
    stubFetch([{ status: 200, text: '<html>maintenance</html>' }]);
    const error = await new RootKeyClient(testConfig())
      .request({ method: 'GET', path: 'platform/files' })
      .catch((e: unknown) => e);
    expect((error as Error).message).toContain('Expected JSON');
  });
});
