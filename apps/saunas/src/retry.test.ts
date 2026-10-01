import { describe, expect, it } from 'vitest';

import { isRetryableUpstreamError, withRetry } from './retry';

/** Ei odota oikeasti: kerää tauot talteen. */
function fakeSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe('withRetry', () => {
  it('palauttaa tuloksen, kun ensimmäinen yritys onnistuu', async () => {
    const { sleep, waits } = fakeSleep();
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        return 'ok';
      },
      { attempts: 2, backoffMs: 100, isRetryable: () => true, sleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('yrittää uudelleen verkkovirheen jälkeen', async () => {
    const { sleep, waits } = fakeSleep();
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new TypeError('fetch failed');
        return 'toinen onnistui';
      },
      { attempts: 2, backoffMs: 300, isRetryable: isRetryableUpstreamError, sleep },
    );
    expect(result).toBe('toinen onnistui');
    expect(calls).toBe(2);
    expect(waits).toEqual([300]);
  });

  it('ei yritä uudelleen 4xx-virheen jälkeen', async () => {
    const { sleep, waits } = fakeSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error('Saunahaku vastasi 404'), { status: 404 });
        },
        { attempts: 2, backoffMs: 300, isRetryable: isRetryableUpstreamError, sleep },
      ),
    ).rejects.toThrow('404');
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('yrittää uudelleen 5xx-virheen jälkeen ja heittää viimeisen virheen', async () => {
    const { sleep, waits } = fakeSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error(`Saunahaku vastasi 50${calls}`), { status: 500 + calls });
        },
        { attempts: 2, backoffMs: 300, isRetryable: isRetryableUpstreamError, sleep },
      ),
    ).rejects.toThrow('Saunahaku vastasi 502');
    expect(calls).toBe(2);
    expect(waits).toEqual([300]);
  });

  it('attempts=1 ei tee uusintaa', async () => {
    const { sleep, waits } = fakeSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('verkkovirhe');
        },
        { attempts: 1, backoffMs: 100, isRetryable: () => true, sleep },
      ),
    ).rejects.toThrow('verkkovirhe');
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });
});

describe('isRetryableUpstreamError', () => {
  it('uusii 5xx-virheet ja verkkoyhteyden virheet', () => {
    expect(isRetryableUpstreamError({ status: 500 })).toBe(true);
    expect(isRetryableUpstreamError({ status: 503 })).toBe(true);
    expect(isRetryableUpstreamError(new TypeError('fetch failed'))).toBe(true);
  });

  it('ei uusi 4xx-virheitä eikä muotovirhettä (status 0)', () => {
    expect(isRetryableUpstreamError({ status: 400 })).toBe(false);
    expect(isRetryableUpstreamError({ status: 404 })).toBe(false);
    // status 0 = vastauksen muoto oli odottamaton → sama vastaus toistuisi.
    expect(isRetryableUpstreamError({ status: 0 })).toBe(false);
  });
});
