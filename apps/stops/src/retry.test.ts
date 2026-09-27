import { describe, expect, it } from 'vitest';

import { isRetryableUpstreamError, withRetry } from './retry';
import { SiriUpstreamError } from './siri-sm';

/** Uusintayritys ei saa odottaa oikeasti testeissä. */
function noSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe('withRetry', () => {
  it('palauttaa ensimmäisen onnistuneen tuloksen ilman uusintaa', async () => {
    const { sleep, waits } = noSleep();
    let calls = 0;

    const result = await withRetry(
      async () => {
        calls += 1;
        return 'ok';
      },
      { attempts: 2, backoffMs: 250, isRetryable: isRetryableUpstreamError, sleep },
    );

    expect(result).toBe('ok');
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('yrittää uudelleen 5xx-virheen jälkeen ja onnistuu', async () => {
    const { sleep, waits } = noSleep();
    let calls = 0;

    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new SiriUpstreamError(500, 'Something went wrong');
        return 'toinen yritys';
      },
      { attempts: 2, backoffMs: 250, isRetryable: isRetryableUpstreamError, sleep },
    );

    expect(result).toBe('toinen yritys');
    expect(calls).toBe(2);
    expect(waits).toEqual([250]);
  });

  it('heittää viimeisen virheen, kun kaikki yritykset epäonnistuvat', async () => {
    const { sleep, waits } = noSleep();
    let calls = 0;

    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new SiriUpstreamError(503, 'yhteys poikki');
        },
        { attempts: 2, backoffMs: 250, isRetryable: isRetryableUpstreamError, sleep },
      ),
    ).rejects.toThrow('Waltti SIRI SM vastasi 503');

    expect(calls).toBe(2);
    expect(waits).toEqual([250]);
  });

  it('ei yritä uudelleen 4xx-virhettä (oma pyyntö on väärä)', async () => {
    const { sleep, waits } = noSleep();
    let calls = 0;

    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new SiriUpstreamError(406, 'PreviewInterval puuttuu');
        },
        { attempts: 3, backoffMs: 250, isRetryable: isRetryableUpstreamError, sleep },
      ),
    ).rejects.toThrow('Waltti SIRI SM vastasi 406');

    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('yrittää uudelleen verkkovirheen jälkeen (ei statuskoodia)', async () => {
    const { sleep } = noSleep();
    let calls = 0;

    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new TypeError('fetch failed');
        },
        { attempts: 2, backoffMs: 10, isRetryable: isRetryableUpstreamError, sleep },
      ),
    ).rejects.toThrow('fetch failed');

    expect(calls).toBe(2);
  });

  it('kutsuu onRetry-takaisinkutsua ennen uusintaa', async () => {
    const { sleep } = noSleep();
    const retries: Array<{ attempt: number; message: string }> = [];

    await withRetry(
      async () => {
        if (retries.length === 0) throw new SiriUpstreamError(500, 'virhe');
        return 'ok';
      },
      {
        attempts: 2,
        backoffMs: 5,
        isRetryable: isRetryableUpstreamError,
        sleep,
        onRetry: (error, attempt) => {
          retries.push({ attempt, message: (error as Error).message });
        },
      },
    );

    expect(retries).toEqual([{ attempt: 1, message: 'Waltti SIRI SM vastasi 500' }]);
  });

  it('käsittelee attempts-arvon 1 niin, ettei uusintaa tehdä', async () => {
    const { sleep, waits } = noSleep();
    let calls = 0;

    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new SiriUpstreamError(500, 'virhe');
        },
        { attempts: 1, backoffMs: 250, isRetryable: isRetryableUpstreamError, sleep },
      ),
    ).rejects.toThrow('Waltti SIRI SM vastasi 500');

    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });
});

describe('isRetryableUpstreamError', () => {
  it('pitää 5xx-virhettä uusittavana', () => {
    expect(isRetryableUpstreamError(new SiriUpstreamError(500, ''))).toBe(true);
    expect(isRetryableUpstreamError(new SiriUpstreamError(503, ''))).toBe(true);
  });

  it('ei pidä 4xx-virhettä uusittavana', () => {
    expect(isRetryableUpstreamError(new SiriUpstreamError(400, ''))).toBe(false);
    expect(isRetryableUpstreamError(new SiriUpstreamError(406, ''))).toBe(false);
  });

  it('pitää virhettä ilman statuskoodia uusittavana (verkko/aikakatkaisu)', () => {
    expect(isRetryableUpstreamError(new Error('timeout'))).toBe(true);
    expect(isRetryableUpstreamError(null)).toBe(true);
  });
});

describe('SiriUpstreamError', () => {
  it('kuljettaa statuskoodin ja leikatun rungon', () => {
    const error = new SiriUpstreamError(500, `  ${'x'.repeat(400)}  `);

    expect(error.status).toBe(500);
    expect(error.name).toBe('SiriUpstreamError');
    expect(error.message).toBe('Waltti SIRI SM vastasi 500');
    expect(error.body).toHaveLength(120);
  });
});
