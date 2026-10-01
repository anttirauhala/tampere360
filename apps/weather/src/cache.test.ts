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
  it('käyttää välimuistissa olevaa arvoa TTL:n ajan', async () => {
    const clock = fakeClock();
    const cache = createKeyedCache<string>({
      ttlMs: 1000,
      staleMaxMs: 10_000,
      maxEntries: 1,
      now: clock.now,
    });
    let loads = 0;
    const load = async () => {
      loads += 1;
      return `arvo-${loads}`;
    };

    expect((await cache.get('current', load)).value).toBe('arvo-1');
    clock.advance(999);
    expect((await cache.get('current', load)).value).toBe('arvo-1');
    expect(loads).toBe(1);

    clock.advance(2);
    expect((await cache.get('current', load)).value).toBe('arvo-2');
    expect(loads).toBe(2);
  });

  it('jakaa samanaikaisen haun (in-flight de-dupe)', async () => {
    const cache = createKeyedCache<string>({
      ttlMs: 1000,
      staleMaxMs: 10_000,
      maxEntries: 1,
      now: Date.now,
    });
    let loads = 0;
    const load = () =>
      new Promise<string>((resolve) => {
        loads += 1;
        setTimeout(() => resolve('valmis'), 5);
      });

    const results = await Promise.all([
      cache.get('current', load),
      cache.get('current', load),
      cache.get('current', load),
    ]);
    expect(results.map((entry) => entry.value)).toEqual(['valmis', 'valmis', 'valmis']);
    expect(loads).toBe(1);
  });

  it('palauttaa vanhan arvon stale-lippu päällä, kun haku epäonnistuu', async () => {
    const clock = fakeClock();
    const cache = createKeyedCache<string>({
      ttlMs: 1000,
      staleMaxMs: 5000,
      maxEntries: 1,
      now: clock.now,
    });

    await cache.get('current', async () => 'edellinen');
    clock.advance(2000);

    const entry = await cache.get('current', async () => {
      throw new Error('FMI WFS vastasi 500');
    });
    expect(entry.value).toBe('edellinen');
    expect(entry.stale).toBe(true);
  });

  it('nostaa virheen, kun vanhakaan arvo ei enää kelpaa', async () => {
    const clock = fakeClock();
    const cache = createKeyedCache<string>({
      ttlMs: 1000,
      staleMaxMs: 5000,
      maxEntries: 1,
      now: clock.now,
    });

    await cache.get('current', async () => 'edellinen');
    clock.advance(5001);

    await expect(
      cache.get('current', async () => {
        throw new Error('FMI WFS vastasi 500');
      }),
    ).rejects.toThrow('FMI WFS vastasi 500');
  });

  it('nostaa virheen heti, jos vanhaa arvoa ei ole', async () => {
    const cache = createKeyedCache<string>({
      ttlMs: 1000,
      staleMaxMs: 5000,
      maxEntries: 1,
      now: Date.now,
    });

    await expect(
      cache.get('current', async () => {
        throw new Error('verkkovirhe');
      }),
    ).rejects.toThrow('verkkovirhe');
  });
});
