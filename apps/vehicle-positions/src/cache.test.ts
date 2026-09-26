import { describe, expect, it } from 'vitest';

import { createSnapshotCache } from './cache';

/** Deterministinen kello: aikaa siirretään käsin. */
function createClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('createSnapshotCache', () => {
  it('käyttää välimuistia TTL:n sisällä (yksi upstream-kutsu monelle pyynnölle)', async () => {
    const clock = createClock();
    let loads = 0;
    const cache = createSnapshotCache<string>({
      ttlMs: 5_000,
      staleMaxMs: 60_000,
      now: clock.now,
      load: async () => {
        loads += 1;
        return `snapshot-${loads}`;
      },
    });

    expect((await cache.get()).value).toBe('snapshot-1');
    clock.advance(4_999);
    expect((await cache.get()).value).toBe('snapshot-1');
    expect(loads).toBe(1);

    clock.advance(1);
    const refreshed = await cache.get();
    expect(refreshed.value).toBe('snapshot-2');
    expect(refreshed.stale).toBe(false);
    expect(loads).toBe(2);
  });

  it('jakaa yhden käynnissä olevan haun rinnakkaisille pyynnöille', async () => {
    const clock = createClock();
    let loads = 0;
    const cache = createSnapshotCache<string>({
      ttlMs: 5_000,
      staleMaxMs: 60_000,
      now: clock.now,
      load: async () => {
        loads += 1;
        await Promise.resolve();
        return 'snapshot';
      },
    });

    const results = await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(loads).toBe(1);
    expect(results.map((r) => r.value)).toEqual(['snapshot', 'snapshot', 'snapshot']);
  });

  it('palauttaa virhetilanteessa vanhan snapshotin stale-merkinnällä', async () => {
    const clock = createClock();
    let fail = false;
    const cache = createSnapshotCache<string>({
      ttlMs: 5_000,
      staleMaxMs: 60_000,
      now: clock.now,
      load: async () => {
        if (fail) throw new Error('Waltti SIRI vastasi 503');
        return 'snapshot';
      },
    });

    await cache.get();
    clock.advance(10_000);
    fail = true;

    const stale = await cache.get();
    expect(stale.value).toBe('snapshot');
    expect(stale.stale).toBe(true);
  });

  it('nostaa virheen, kun snapshotkin on liian vanha', async () => {
    const clock = createClock();
    let fail = false;
    const cache = createSnapshotCache<string>({
      ttlMs: 5_000,
      staleMaxMs: 60_000,
      now: clock.now,
      load: async () => {
        if (fail) throw new Error('Waltti SIRI vastasi 503');
        return 'snapshot';
      },
    });

    await cache.get();
    clock.advance(61_000);
    fail = true;

    await expect(cache.get()).rejects.toThrow('Waltti SIRI vastasi 503');
  });

  it('nostaa virheen, jos käytettävissä ei ole mitään snapshotia', async () => {
    const cache = createSnapshotCache<string>({
      ttlMs: 5_000,
      staleMaxMs: 60_000,
      now: () => 0,
      load: async () => {
        throw new Error('puuttuva API-avain');
      },
    });

    await expect(cache.get()).rejects.toThrow('puuttuva API-avain');
  });

  it('toipuu virheestä, kun upstream palaa', async () => {
    const clock = createClock();
    let fail = true;
    const cache = createSnapshotCache<string>({
      ttlMs: 5_000,
      staleMaxMs: 60_000,
      now: clock.now,
      load: async () => {
        if (fail) throw new Error('503');
        return 'snapshot';
      },
    });

    await expect(cache.get()).rejects.toThrow('503');
    fail = false;
    expect((await cache.get()).value).toBe('snapshot');
  });
});
