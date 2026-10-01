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

  it('yrittää uudelleen aikakatkaisun jälkeen (kuten 27.9.2026 mitattu 7,6 s)', async () => {
    const { sleep, waits } = fakeSleep();
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          const error = new Error('The operation was aborted due to timeout');
          error.name = 'TimeoutError';
          throw error;
        }
        return 'toinen onnistui';
      },
      { attempts: 2, backoffMs: 250, isRetryable: isRetryableUpstreamError, sleep },
    );
    expect(result).toBe('toinen onnistui');
    expect(calls).toBe(2);
    expect(waits).toEqual([250]);
  });

  it('ei yritä uudelleen 4xx-virheen jälkeen', async () => {
    const { sleep, waits } = fakeSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error('Digitraffic vastasi 400'), { status: 400 });
        },
        { attempts: 2, backoffMs: 250, isRetryable: isRetryableUpstreamError, sleep },
      ),
    ).rejects.toThrow('400');
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('yrittää uudelleen 5xx-virheen jälkeen ja heittää viimeisen virheen', async () => {
    const { sleep, waits } = fakeSleep();
    let calls = 0;
    const errors: string[] = [];
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error(`Digitraffic vastasi 50${calls}`), { status: 500 + calls });
        },
        {
          attempts: 2,
          backoffMs: 400,
          isRetryable: isRetryableUpstreamError,
          sleep,
          onRetry: (error) => {
            errors.push((error as Error).message);
          },
        },
      ),
    ).rejects.toThrow('Digitraffic vastasi 502');
    expect(calls).toBe(2);
    expect(waits).toEqual([400]);
    expect(errors).toEqual(['Digitraffic vastasi 501']);
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
    expect(isRetryableUpstreamError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableUpstreamError(new Error('The operation was aborted due to timeout'))).toBe(
      true,
    );
  });

  it('ei uusi 4xx-virheitä', () => {
    expect(isRetryableUpstreamError({ status: 400 })).toBe(false);
    expect(isRetryableUpstreamError({ status: 404 })).toBe(false);
    expect(isRetryableUpstreamError({ status: 406 })).toBe(false);
  });
});
