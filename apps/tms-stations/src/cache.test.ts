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
      maxEntries: 10,
      now: clock.now,
    });
    let loads = 0;
    const load = async () => {
      loads += 1;
      return `arvo-${loads}`;
    };

    expect((await cache.get('a', load)).value).toBe('arvo-1');
    clock.advance(999);
    expect((await cache.get('a', load)).value).toBe('arvo-1');
    expect(loads).toBe(1);

    clock.advance(2);
    expect((await cache.get('a', load)).value).toBe('arvo-2');
    expect(loads).toBe(2);
  });

  it('jakaa samanaikaisen haun (in-flight de-dupe)', async () => {
    const clock = fakeClock();
    const cache = createKeyedCache<string>({
      ttlMs: 1000,
      staleMaxMs: 10_000,
      maxEntries: 10,
      now: clock.now,
    });
    let loads = 0;
    const load = () =>
      new Promise<string>((resolve) => {
        loads += 1;
        setTimeout(() => resolve('valmis'), 5);
      });

    const results = await Promise.all([
      cache.get('a', load),
      cache.get('a', load),
      cache.get('a', load),
    ]);
    expect(results.map((entry) => entry.value)).toEqual(['valmis', 'valmis', 'valmis']);
    expect(loads).toBe(1);
  });

  it('palauttaa vanhan arvon stale-lippu päällä, kun haku epäonnistuu', async () => {
    const clock = fakeClock();
    const cache = createKeyedCache<string>({
      ttlMs: 1000,
      staleMaxMs: 5000,
      maxEntries: 10,
      now: clock.now,
    });

    await cache.get('live', async () => 'snapshot-1');
    clock.advance(2000);

    const entry = await cache.get('live', async () => {
      throw new Error('Digitraffic vastasi 500');
    });
    expect(entry.value).toBe('snapshot-1');
    expect(entry.stale).toBe(true);
  });

  it('nostaa virheen, kun vanhakaan arvo ei enää kelpaa', async () => {
    const clock = fakeClock();
    const cache = createKeyedCache<string>({
      ttlMs: 1000,
      staleMaxMs: 5000,
      maxEntries: 10,
      now: clock.now,
    });

    await cache.get('live', async () => 'snapshot-1');
    clock.advance(5001);

    await expect(
      cache.get('live', async () => {
        throw new Error('Digitraffic vastasi 500');
      }),
    ).rejects.toThrow('Digitraffic vastasi 500');
  });

  it('nostaa virheen heti, jos vanhaa arvoa ei ole', async () => {
    const clock = fakeClock();
    const cache = createKeyedCache<string>({
      ttlMs: 1000,
      staleMaxMs: 5000,
      maxEntries: 10,
      now: clock.now,
    });

    await expect(
      cache.get('uusi', async () => {
        throw new Error('verkkovirhe');
      }),
    ).rejects.toThrow('verkkovirhe');
  });

  it('kutsuu latausta uudelleen epäonnistumisen jälkeen', async () => {
    const clock = fakeClock();
    const cache = createKeyedCache<string>({
      ttlMs: 1000,
      staleMaxMs: 5000,
      maxEntries: 10,
      now: clock.now,
    });

    await expect(
      cache.get('a', async () => {
        throw new Error('virhe');
      }),
    ).rejects.toThrow('virhe');

    clock.advance(10);
    expect((await cache.get('a', async () => 'toinen-yritys')).value).toBe('toinen-yritys');
  });

  it('rajaa muistissa pidettävien avainten määrän (vanhin pois)', async () => {
    const clock = fakeClock();
    const cache = createKeyedCache<string>({
      ttlMs: 1000,
      staleMaxMs: 1000,
      maxEntries: 2,
      now: clock.now,
    });

    await cache.get('a', async () => 'A');
    await cache.get('b', async () => 'B');
    await cache.get('c', async () => 'C');

    expect(cache.peek('a')).toBeNull();
    expect(cache.peek('b')).toBe('B');
    expect(cache.peek('c')).toBe('C');
  });

  it('peek ei laukaise hakua', () => {
    const cache = createKeyedCache<string>({
      ttlMs: 1000,
      staleMaxMs: 1000,
      maxEntries: 2,
      now: Date.now,
    });
    expect(cache.peek('olematon')).toBeNull();
  });
});
