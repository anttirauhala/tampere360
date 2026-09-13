import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchWithRetry, HttpFetchError } from './http';

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchWithRetry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('palauttaa vastauksen onnistuneella haulla', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchWithRetry('https://example.test/data', { maxAttempts: 3 });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true });
    expect(result.attempts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('yrittää uudelleen 503-virheen jälkeen ja onnistuu', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchWithRetry('https://example.test/data', {
      maxAttempts: 3,
      baseDelayMs: 1,
    });

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ei yritä uudelleen 404-virheellä', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchWithRetry('https://example.test/data', { maxAttempts: 3, baseDelayMs: 1 }),
    ).rejects.toThrow(HttpFetchError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('heittää virheen, kun kaikki yritykset epäonnistuvat', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchWithRetry('https://example.test/data', { maxAttempts: 2, baseDelayMs: 1 }),
    ).rejects.toThrow(/failed after 2 attempts/);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('yrittää uudelleen verkkovirheessä', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network error'))
      .mockResolvedValueOnce(jsonResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchWithRetry('https://example.test/data', {
      maxAttempts: 3,
      baseDelayMs: 1,
    });

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sisältää oletusotsakkeet', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    await fetchWithRetry('https://example.test/data');

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const init = call?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      'user-agent': expect.stringContaining('tampere360-ingest'),
    });
  });
});
