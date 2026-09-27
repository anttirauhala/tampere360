import { describe, expect, it } from 'vitest';

import { createKeyedCache } from './cache';

/** Keksitty kello, jota siirretään käsin — testi ei riipu oikeasta ajasta. */
function createClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('createKeyedCache', () => {
  it('hakee arvon kerran ja palvelee sitä TTL:n ajan välimuistista', async () => {
    const clock = createClock();
    let loads = 0;
    const cache = createKeyedCache<string>({
      ttlMs: 15_000,
      staleMaxMs: 60_000,
      maxEntries: 10,
      now: clock.now,
    });

    const load = async () => {
      loads += 1;
      return `arvo-${loads}`;
    };

    const first = await cache.get('0015', load);
    clock.advance(14_999);
    const second = await cache.get('0015', load);

    expect(loads).toBe(1);
    expect(first).toMatchObject({ value: 'arvo-1', stale: false });
    expect(second).toMatchObject({ value: 'arvo-1', stale: false });
    expect(second.fetchedAt).toBe(first.fetchedAt);
  });

  it('hakee uuden arvon, kun TTL on kulunut', async () => {
    const clock = createClock();
    let loads = 0;
    const cache = createKeyedCache<string>({
      ttlMs: 15_000,
      staleMaxMs: 60_000,
      maxEntries: 10,
      now: clock.now,
    });
    const load = async () => `arvo-${(loads += 1)}`;

    await cache.get('0015', load);
    clock.advance(15_000);
    const refreshed = await cache.get('0015', load);

    expect(loads).toBe(2);
    expect(refreshed.value).toBe('arvo-2');
  });

  it('pitää pysäkkien välimuistit erillään', async () => {
    const clock = createClock();
    const cache = createKeyedCache<string>({
      ttlMs: 15_000,
      staleMaxMs: 60_000,
      maxEntries: 10,
      now: clock.now,
    });

    expect((await cache.get('0015', async () => 'Keskustori')).value).toBe('Keskustori');
    expect((await cache.get('0504', async () => 'Rautatieasema')).value).toBe('Rautatieasema');
    // Sama avain palvellaan välimuistista, eri avain omasta arvostaan.
    expect((await cache.get('0015', async () => 'väärä')).value).toBe('Keskustori');
  });

  it('jakaa samanaikaiset pyynnöt yhdellä upstream-kutsulla (in-flight de-dupe)', async () => {
    const clock = createClock();
    let loads = 0;
    const cache = createKeyedCache<string>({
      ttlMs: 15_000,
      staleMaxMs: 60_000,
      maxEntries: 10,
      now: clock.now,
    });
    const load = async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'arvo';
    };

    const results = await Promise.all([
      cache.get('0015', load),
      cache.get('0015', load),
      cache.get('0015', load),
    ]);

    expect(loads).toBe(1);
    expect(results.map((entry) => entry.value)).toEqual(['arvo', 'arvo', 'arvo']);
  });

  it('palauttaa vanhan arvon stale:true, kun upstream-haku epäonnistuu', async () => {
    const clock = createClock();
    const cache = createKeyedCache<string>({
      ttlMs: 15_000,
      staleMaxMs: 60_000,
      maxEntries: 10,
      now: clock.now,
    });

    await cache.get('0015', async () => 'arvo');
    clock.advance(20_000);
    const stale = await cache.get('0015', async () => {
      throw new Error('Waltti 500');
    });

    expect(stale).toMatchObject({ value: 'arvo', stale: true });
  });

  it('nostaa virheen, kun vanha arvo on liian vanha', async () => {
    const clock = createClock();
    const cache = createKeyedCache<string>({
      ttlMs: 15_000,
      staleMaxMs: 60_000,
      maxEntries: 10,
      now: clock.now,
    });

    await cache.get('0015', async () => 'arvo');
    clock.advance(60_001);

    await expect(
      cache.get('0015', async () => {
        throw new Error('Waltti 500');
      }),
    ).rejects.toThrow('Waltti 500');
  });

  it('nostaa virheen, jos välimuistissa ei ole mitään', async () => {
    const cache = createKeyedCache<string>({
      ttlMs: 15_000,
      staleMaxMs: 60_000,
      maxEntries: 10,
      now: () => 0,
    });

    await expect(
      cache.get('0015', async () => {
        throw new Error('ei verkkoa');
      }),
    ).rejects.toThrow('ei verkkoa');
  });

  it('peek lukee vain muistissa olevan arvon eikä laukaise hakua', async () => {
    const cache = createKeyedCache<string>({
      ttlMs: 15_000,
      staleMaxMs: 60_000,
      maxEntries: 10,
      now: () => 0,
    });

    expect(cache.peek('gtfs')).toBeNull();
    await cache.get('gtfs', async () => 'rekisteri');
    expect(cache.peek('gtfs')).toBe('rekisteri');
  });

  it('rajaa muistissa pidettävien avainten määrän (vanhin pois)', async () => {
    const cache = createKeyedCache<string>({
      ttlMs: 15_000,
      staleMaxMs: 60_000,
      maxEntries: 2,
      now: () => 0,
    });

    await cache.get('a', async () => 'A');
    await cache.get('b', async () => 'B');
    await cache.get('c', async () => 'C'); // pudottaa vanhimman ('a')

    expect(cache.peek('a')).toBeNull();
    expect(cache.peek('b')).toBe('B');
    expect(cache.peek('c')).toBe('C');
  });
});

describe('createKeyedCache — epäonnistumisen jäähdytys', () => {
  it('ei kutsu upstreamia uudelleen jäähdytyksen aikana', async () => {
    const clock = createClock();
    let loads = 0;
    const cache = createKeyedCache<string>({
      ttlMs: 15_000,
      staleMaxMs: 60_000,
      maxEntries: 10,
      failureCooldownMs: 30_000,
      now: clock.now,
    });
    const load = async () => {
      loads += 1;
      throw new Error(`virhe ${loads}`);
    };

    await expect(cache.get('6833', load)).rejects.toThrow('virhe 1');
    clock.advance(15_000); // selaimen seuraava pollaus
    await expect(cache.get('6833', load)).rejects.toThrow('virhe 1');

    expect(loads).toBe(1);
  });

  it('yrittää uudelleen, kun jäähdytys on kulunut', async () => {
    const clock = createClock();
    let loads = 0;
    const cache = createKeyedCache<string>({
      ttlMs: 15_000,
      staleMaxMs: 60_000,
      maxEntries: 10,
      failureCooldownMs: 30_000,
      now: clock.now,
    });
    const load = async () => {
      loads += 1;
      if (loads === 1) throw new Error('ei verkkoa');
      return 'nyt onnistui';
    };

    await expect(cache.get('6833', load)).rejects.toThrow('ei verkkoa');
    clock.advance(30_000);
    const value = await cache.get('6833', load);

    expect(loads).toBe(2);
    expect(value).toMatchObject({ value: 'nyt onnistui', stale: false });
  });

  it('onnistuminen poistaa jäähdytyksen', async () => {
    const clock = createClock();
    let loads = 0;
    const cache = createKeyedCache<string>({
      ttlMs: 15_000,
      staleMaxMs: 60_000,
      maxEntries: 10,
      failureCooldownMs: 30_000,
      now: clock.now,
    });
    const load = async () => `arvo-${(loads += 1)}`;

    await cache.get('6833', load); // onnistuu
    clock.advance(30_000); // TTL ohitse → uusi haku onnistuu
    await cache.get('6833', load);
    clock.advance(30_000);
    await cache.get('6833', load);

    // Kaikki kolme hakua tehtiin: jäähdytys ei estä onnistumisen jälkeistä hakua.
    expect(loads).toBe(3);
  });

  it('vanha arvo ohittaa jäähdytyksen (tuoreus voittaa)', async () => {
    const clock = createClock();
    let loads = 0;
    const cache = createKeyedCache<string>({
      ttlMs: 15_000,
      staleMaxMs: 60_000,
      maxEntries: 10,
      failureCooldownMs: 30_000,
      now: clock.now,
    });
    const load = async () => {
      loads += 1;
      if (loads === 1) return 'ensimmainen';
      throw new Error('ei verkkoa');
    };

    await cache.get('6833', load); // onnistuu → välimuistissa arvo
    clock.advance(15_000);
    const stale = await cache.get('6833', load); // epäonnistuu → varavastaus
    clock.advance(5_000);
    const again = await cache.get('6833', load); // jäähdytyksestä huolimatta yrittää

    expect(stale).toMatchObject({ value: 'ensimmainen', stale: true });
    expect(again).toMatchObject({ value: 'ensimmainen', stale: true });
    expect(loads).toBe(3);
  });

  it('ilman jäähdytysasetusta virhe toistetaan joka kutsulla', async () => {
    const clock = createClock();
    let loads = 0;
    const cache = createKeyedCache<string>({
      ttlMs: 15_000,
      staleMaxMs: 60_000,
      maxEntries: 10,
      now: clock.now,
    });
    const load = async () => {
      loads += 1;
      throw new Error('virhe');
    };

    await expect(cache.get('6833', load)).rejects.toThrow('virhe');
    clock.advance(1_000);
    await expect(cache.get('6833', load)).rejects.toThrow('virhe');

    expect(loads).toBe(2);
  });
});
