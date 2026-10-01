import { describe, expect, it } from 'vitest';

import { createKeyedCache } from './cache';

/** Käsiohjattu kello, jotta testit eivät riipu oikeasta ajasta. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('createKeyedCache', () => {
  it('käyttää välimuistissa olevaa arvoa TTL:n ajan (5 min)', async () => {
    const clock = fakeClock();
    const cache = createKeyedCache<string>({
      ttlMs: 300_000,
      staleMaxMs: 86_400_000,
      maxEntries: 1,
      now: clock.now,
    });
    let loads = 0;
    const load = async () => {
      loads += 1;
      return `arvo-${loads}`;
    };

    expect((await cache.get('latest', load)).value).toBe('arvo-1');
    clock.advance(299_999);
    expect((await cache.get('latest', load)).value).toBe('arvo-1');
    expect(loads).toBe(1);

    clock.advance(2);
    expect((await cache.get('latest', load)).value).toBe('arvo-2');
    expect(loads).toBe(2);
  });

  it('jakaa samanaikaisen haun (in-flight de-dupe)', async () => {
    const clock = fakeClock();
    const cache = createKeyedCache<string>({
      ttlMs: 300_000,
      staleMaxMs: 86_400_000,
      maxEntries: 1,
      now: clock.now,
    });
    let loads = 0;
    const load = () =>
      new Promise<string>((resolve) => {
        loads += 1;
        setTimeout(() => resolve('valmis'), 5);
      });

    const results = await Promise.all([
      cache.get('latest', load),
      cache.get('latest', load),
      cache.get('latest', load),
    ]);
    expect(results.map((entry) => entry.value)).toEqual(['valmis', 'valmis', 'valmis']);
    expect(loads).toBe(1);
  });

  it('palauttaa vanhan arvon stale-lippu päällä, kun haku epäonnistuu', async () => {
    const clock = fakeClock();
    const cache = createKeyedCache<string>({
      ttlMs: 300_000,
      staleMaxMs: 86_400_000,
      maxEntries: 1,
      now: clock.now,
    });

    await cache.get('latest', async () => '11.9');
    clock.advance(400_000);

    const entry = await cache.get('latest', async () => {
      throw new Error('SYKE vastasi 500');
    });
    expect(entry.value).toBe('11.9');
    expect(entry.stale).toBe(true);
  });

  it('nostaa virheen, kun vanhakaan arvo ei enää kelpaa', async () => {
    const clock = fakeClock();
    const cache = createKeyedCache<string>({
      ttlMs: 300_000,
      staleMaxMs: 86_400_000,
      maxEntries: 1,
      now: clock.now,
    });

    await cache.get('latest', async () => '11.9');
    clock.advance(86_400_001);

    await expect(
      cache.get('latest', async () => {
        throw new Error('SYKE vastasi 500');
      }),
    ).rejects.toThrow('SYKE vastasi 500');
  });

  it('peek ei laukaise hakua', () => {
    const cache = createKeyedCache<string>({
      ttlMs: 300_000,
      staleMaxMs: 86_400_000,
      maxEntries: 1,
      now: Date.now,
    });
    expect(cache.peek('latest')).toBeNull();
  });
});
