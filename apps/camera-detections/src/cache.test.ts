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
      maxEntries: 1,
      now: clock.now,
    });
    let loads = 0;
    const load = async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'sama';
    };

    const [first, second] = await Promise.all([cache.get('a', load), cache.get('a', load)]);
    expect([first.value, second.value]).toEqual(['sama', 'sama']);
    expect(loads).toBe(1);
  });

  it('palauttaa vanhan arvon stale-lippu­merkillä, kun haku epäonnistuu', async () => {
    const clock = fakeClock();
    const cache = createKeyedCache<string>({
      ttlMs: 100,
      staleMaxMs: 10_000,
      maxEntries: 1,
      now: clock.now,
    });
    await cache.get('a', async () => 'vanha');
    clock.advance(200);

    const entry = await cache.get('a', async () => {
      throw new Error('upstream rikki');
    });
    expect(entry.value).toBe('vanha');
    expect(entry.stale).toBe(true);
  });

  it('ei tarjoile vanhentunutta arvoa, kun staleMaxMs on sama kuin TTL', async () => {
    // Presigned-kuva-URL käyttää tätä: vanhentunutta URL:ia ei koskaan näytetä.
    const clock = fakeClock();
    const cache = createKeyedCache<string>({
      ttlMs: 500,
      staleMaxMs: 500,
      maxEntries: 1,
      now: clock.now,
    });
    await cache.get('a', async () => 'url');
    clock.advance(501);

    await expect(
      cache.get('a', async () => {
        throw new Error('presign epäonnistui');
      }),
    ).rejects.toThrow('presign epäonnistui');
  });

  it('heittää virheen ilman vanhaa arvoa ja rajaa avainten määrän', async () => {
    const clock = fakeClock();
    const cache = createKeyedCache<string>({
      ttlMs: 1000,
      staleMaxMs: 10_000,
      maxEntries: 1,
      now: clock.now,
    });

    await expect(
      cache.get('a', async () => {
        throw new Error('ei välimuistia');
      }),
    ).rejects.toThrow('ei välimuistia');

    await cache.get('a', async () => 'ensimmainen');
    await cache.get('b', async () => 'toinen');
    expect(cache.peek('a')).toBeNull();
    expect(cache.peek('b')).toBe('toinen');
  });
});
