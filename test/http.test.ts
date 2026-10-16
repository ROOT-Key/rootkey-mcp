import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError, apiErrorFromBody, describeApiError, redactSecrets, registerSecret } from '../src/errors.js';
import { RootKeyClient, parseRetryAfter } from '../src/http.js';
import { ORG_A, ORG_B, TEST_PAT, patConfig, stubFetch, testConfig } from './helpers.js';

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
    // There is one public API; the message must not send the model hunting for a development host or
    // claim that the key prefix decides which environment is called.
    expect(error.message).not.toMatch(/development/i);
    expect(error.message).not.toMatch(/dev-api/i);
    expect(error.message).not.toMatch(/only work/i);
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

describe('redirect policy', () => {
  const callBinary = (config = testConfig(), method: 'GET' | 'PUT' | 'POST' | 'DELETE' = 'GET', body?: unknown) =>
    new RootKeyClient(config).requestBinary({ method, path: 'platform/files/f1/download', ...(body === undefined ? {} : { body }) });

  it.each([307, 308, 303, 302, 301])('refuses to replay a PUT after a %s, and sends it exactly once', async (status) => {
    const stub = stubFetch([{ status, headers: { location: '/api-v1/platform/vaults/0xabc/moved' } }, { json: {} }]);
    const error = await new RootKeyClient(testConfig())
      .request({ method: 'PUT', path: 'platform/vaults/0xabc', body: { name: 'x' } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toMatch(/never replayed/);
    expect((error as ApiError).status).toBe(status);
    expect(stub.calls).toHaveLength(1);
  });

  it.each(['POST', 'DELETE'] as const)('refuses to follow a redirect for a %s', async (method) => {
    const stub = stubFetch([{ status: 307, headers: { location: 'https://elsewhere.example.net/x' } }, { json: {} }]);
    await expect(new RootKeyClient(testConfig()).request({ method, path: 'platform/vaults' })).rejects.toThrow(/never replayed/);
    expect(stub.calls).toHaveLength(1);
  });

  it('follows a 303 for a GET', async () => {
    const stub = stubFetch([{ status: 303, headers: { location: '/api-v1/platform/files/f1/blob' } }, { text: 'bytes' }]);
    expect(await (await callBinary()).text()).toBe('bytes');
    expect(stub.calls).toHaveLength(2);
  });

  it('refuses a hop to plain http on another host, and does not retry the refusal', async () => {
    const stub = stubFetch([{ status: 302, headers: { location: 'http://cdn.example.net/signed/abc' } }, { text: 'bytes' }]);
    const error = await callBinary().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toMatch(/insecure/);
    expect(stub.calls).toHaveLength(1);
  });

  it('refuses an https to http downgrade even on the same host', async () => {
    const stub = stubFetch([{ status: 302, headers: { location: 'http://api.rootkey.ai/api-v1/platform/files/f1/blob' } }, { text: 'bytes' }]);
    await expect(callBinary()).rejects.toThrow(/insecure/);
    expect(stub.calls).toHaveLength(1);
  });

  it('refuses an https to http hop that stays on loopback: a downgrade is a downgrade', async () => {
    const stub = stubFetch([{ status: 302, headers: { location: 'http://127.0.0.1:3333/x' } }, { text: 'bytes' }]);
    await expect(callBinary()).rejects.toThrow(/insecure/);
    expect(stub.calls).toHaveLength(1);
  });

  it('allows plain http to loopback when the API itself is on loopback', async () => {
    const stub = stubFetch([{ status: 302, headers: { location: 'http://127.0.0.1:3333/api-v1/blob' } }, { text: 'bytes' }]);
    const response = await callBinary(testConfig({ baseUrl: 'http://127.0.0.1:3333/api-v1/' }));
    expect(await response.text()).toBe('bytes');
    expect(stub.calls).toHaveLength(2);
  });

  it('refuses a redirect to a scheme that is not http or https', async () => {
    stubFetch([{ status: 302, headers: { location: 'file:///etc/passwd' } }]);
    await expect(callBinary()).rejects.toThrow(/unsupported URL scheme/);
  });

  it('gives up after five hops, once, without retrying the whole walk', async () => {
    const stub = stubFetch([{ status: 302, headers: { location: '/api-v1/loop' } }]);
    await expect(callBinary()).rejects.toThrow(/Too many redirects/);
    // The first request plus five hops, and no second attempt.
    expect(stub.calls).toHaveLength(6);
  });

  it('never gets the credential back after a hop through another origin (A to B to A)', async () => {
    const stub = stubFetch([
      { status: 302, headers: { location: 'https://cdn.example.net/hop' } },
      { status: 302, headers: { location: 'https://api.rootkey.ai/api-v1/back' } },
      { text: 'bytes' },
    ]);
    await callBinary(patConfig({ ROOTKEY_TEST_MODE: 'true' }));

    expect(stub.calls[0]!.headers.authorization).toBe(`Bearer ${TEST_PAT}`);
    expect(Object.keys(stub.calls[1]!.headers)).toEqual(['accept']);
    expect(Object.keys(stub.calls[2]!.headers)).toEqual(['accept']);
  });

  it('never sends the request body to a second hop', async () => {
    const stub = stubFetch([{ status: 302, headers: { location: '/api-v1/platform/other' } }, { json: {} }]);
    await callBinary();
    expect(stub.calls[1]!.body).toBeUndefined();
  });
});

describe('a DELETE whose first attempt may already have been applied', () => {
  it('reports success when the retry finds the item gone after a lost response', async () => {
    const stub = stubFetch([{ networkError: new TypeError('socket hang up') }, { status: 404, json: { error: { message: 'nf' } } }]);
    const result = await new RootKeyClient(testConfig()).request({ method: 'DELETE', path: 'platform/vaults/0xabc' });

    expect(result).toBeUndefined();
    expect(stub.calls).toHaveLength(2);
  });

  it('reports success when the retry finds the item gone after a gateway error', async () => {
    stubFetch([{ status: 504, text: '' }, { status: 404, json: { error: { message: 'nf' } } }]);
    expect(await new RootKeyClient(testConfig()).request({ method: 'DELETE', path: 'platform/vaults/0xabc' })).toBeUndefined();
  });

  it('still reports a 404 that came on the first attempt: nothing was deleted by this call', async () => {
    stubFetch([{ status: 404, json: { error: { message: 'nf', errorCode: 'resource_not_found' } } }]);
    const error = await new RootKeyClient(testConfig()).request({ method: 'DELETE', path: 'platform/vaults/0xabc' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it('does not turn a 404 after a rate-limit retry into a success: a 429 means the request was refused', async () => {
    stubFetch([{ status: 429, headers: { 'retry-after': '0' }, text: '' }, { status: 404, json: { error: { message: 'nf' } } }]);
    const error = await new RootKeyClient(testConfig()).request({ method: 'DELETE', path: 'platform/vaults/0xabc' }).catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(404);
  });

  it('does not apply to a GET', async () => {
    stubFetch([{ networkError: new TypeError('socket hang up') }, { status: 404, json: { error: { message: 'nf' } } }]);
    const error = await new RootKeyClient(testConfig()).request({ method: 'GET', path: 'platform/vaults/0xabc' }).catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(404);
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

describe('personal access token headers', () => {
  it('sends the token as a Bearer credential and never as x-api-key', async () => {
    const stub = stubFetch([{ json: { ok: true } }]);
    await new RootKeyClient(patConfig()).request({ method: 'GET', path: 'organizations' });

    const headers = stub.calls[0]!.headers;
    expect(headers.authorization).toBe(`Bearer ${TEST_PAT}`);
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('sends the organization it is bound to, and only that one', async () => {
    const stub = stubFetch([{ json: { ok: true } }]);
    const base = new RootKeyClient(patConfig());

    await base.forOrganization(ORG_A).request({ method: 'GET', path: 'platform/files' });
    await base.forOrganization(ORG_B).request({ method: 'GET', path: 'platform/files' });
    await base.request({ method: 'GET', path: 'platform/files' });

    expect(stub.calls[0]?.headers['x-rootkey-organization']).toBe(ORG_A);
    expect(stub.calls[1]?.headers['x-rootkey-organization']).toBe(ORG_B);
    // Binding a derived client must not change the client it came from.
    expect(stub.calls[2]?.headers['x-rootkey-organization']).toBeUndefined();
  });

  it('sends the test or live namespace only when it was configured', async () => {
    const stub = stubFetch([{ json: { ok: true } }]);
    await new RootKeyClient(patConfig({ ROOTKEY_TEST_MODE: 'true' })).request({ method: 'GET', path: 'me' });
    await new RootKeyClient(patConfig({ ROOTKEY_TEST_MODE: 'false' })).request({ method: 'GET', path: 'me' });
    await new RootKeyClient(patConfig()).request({ method: 'GET', path: 'me' });

    expect(stub.calls[0]?.headers['x-test-mode']).toBe('true');
    expect(stub.calls[1]?.headers['x-test-mode']).toBe('false');
    expect(stub.calls[2]?.headers['x-test-mode']).toBeUndefined();
  });

  it('keeps an organization API key on x-api-key alone, whatever organization or mode is asked for', async () => {
    const stub = stubFetch([{ json: { ok: true } }]);
    await new RootKeyClient(testConfig({ testMode: true, organization: ORG_A }))
      .forOrganization(ORG_B)
      .request({ method: 'GET', path: 'platform/files' });

    const headers = stub.calls[0]!.headers;
    expect(headers['x-api-key']).toBe('rk_test_unit');
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-rootkey-organization']).toBeUndefined();
    expect(headers['x-test-mode']).toBeUndefined();
  });

  it('keeps all three headers across a same-origin redirect', async () => {
    const stub = stubFetch([{ status: 302, headers: { location: '/api-v1/platform/files/f1/blob' } }, { text: 'bytes' }]);
    await new RootKeyClient(patConfig({ ROOTKEY_TEST_MODE: 'true' }))
      .forOrganization(ORG_A)
      .requestBinary({ method: 'GET', path: 'platform/files/f1/download' });

    const headers = stub.calls[1]!.headers;
    expect(headers.authorization).toBe(`Bearer ${TEST_PAT}`);
    expect(headers['x-rootkey-organization']).toBe(ORG_A);
    expect(headers['x-test-mode']).toBe('true');
  });

  // The token is the most valuable thing this server holds: a hop to another host must not carry it.
  it('drops the token, the organization and the namespace when a redirect leaves the origin', async () => {
    const stub = stubFetch([{ status: 302, headers: { location: 'https://cdn.example.net/signed/abc' } }, { text: 'bytes' }]);
    await new RootKeyClient(patConfig({ ROOTKEY_TEST_MODE: 'true' }))
      .forOrganization(ORG_A)
      .requestBinary({ method: 'GET', path: 'platform/files/f1/download' });

    expect(stub.calls[1]!.url.origin).toBe('https://cdn.example.net');
    expect(Object.keys(stub.calls[1]!.headers).sort()).toEqual(['accept']);
    expect(JSON.stringify(stub.calls[1]!.headers)).not.toContain(TEST_PAT);
  });

  it('retries with the same headers', async () => {
    const stub = stubFetch([{ status: 503, text: '' }, { json: { ok: true } }]);
    await new RootKeyClient(patConfig()).forOrganization(ORG_A).request({ method: 'GET', path: 'platform/files' });

    expect(stub.calls).toHaveLength(2);
    for (const call of stub.calls) {
      expect(call.headers.authorization).toBe(`Bearer ${TEST_PAT}`);
      expect(call.headers['x-rootkey-organization']).toBe(ORG_A);
    }
  });
});

describe('credential-aware error text', () => {
  it('words a bodyless 401 for a personal access token', () => {
    const message = apiErrorFromBody(401, undefined, '', 'pat').message;
    expect(message).toContain('ROOTKEY_TOKEN');
    expect(message).not.toContain('ROOTKEY_API_KEY');
  });

  it('words a bodyless 403 and 429 for a token without mentioning API keys', () => {
    expect(apiErrorFromBody(403, undefined, '', 'pat').message).not.toMatch(/API key/);
    expect(apiErrorFromBody(429, undefined, '', 'pat').message).not.toMatch(/API key/);
  });

  it('describeApiError adds what to change for a known refusal, and nothing for an unknown one', () => {
    const known = new ApiError({ status: 403, errorCode: 'agent_access_disabled', message: 'Agent access is disabled in this organization.' });
    expect(describeApiError(known, 'pat').split('\n')).toHaveLength(2);
    expect(describeApiError(known, 'pat')).toContain('Settings -> AI agents');

    const unknown = new ApiError({ status: 400, errorCode: 'something_else', message: 'bad' });
    expect(describeApiError(unknown, 'pat')).toBe(unknown.toDisplayString());
  });

  it('redactSecrets removes a registered credential of any shape, including a plain UUID organization key', () => {
    // Built from parts so the fixture is not mistaken for a real credential.
    const legacyKey = ['0a1b2c3d', '4e5f', '4a6b', '8c7d', '9e0f1a2b3c4d'].join('-');
    registerSecret(legacyKey);
    registerSecret('');
    expect(redactSecrets(`key ${legacyKey} twice ${legacyKey}!`)).toBe('key [redacted] twice [redacted]!');
    expect(redactSecrets('nothing to hide here')).toBe('nothing to hide here');
  });

  it('redactSecrets catches a token that is glued to other characters', () => {
    expect(redactSecrets(`x_${TEST_PAT}y`)).not.toContain('rk_pat_');
    expect(redactSecrets(`token=${TEST_PAT}`)).toBe('token=[redacted]');
  });

  it('redactSecrets removes every credential shape this server handles', () => {
    const text = `a ${TEST_PAT} b rk_live_deadbeef c rk_test_deadbeef d rk_agt_deadbeef e rk_conn_deadbeef f Bearer abc.def-ghi`;
    const clean = redactSecrets(text);
    expect(clean).not.toMatch(/rk_(pat|live|test|agt|conn)_/);
    expect(clean).not.toContain('abc.def-ghi');
    expect(clean).toContain('a [redacted] b');
  });
});
