import { describe, expect, it, vi } from 'vitest';

import {
  CHUNK_RELOAD_WINDOW_MS,
  CHUNK_RETRY_PARAM,
  ChunkLoadError,
  type KeyValueStore,
  type LazyModuleLoadOptions,
  createChunkReloadGuard,
  hasChunkRetryFlag,
  loadLazyModule,
  recoverFromChunkError,
  withChunkRetryFlag,
  withoutChunkRetryFlag,
} from './chunk-reload';

/** Muistissa toimiva localStorage-korvaaja (testeissä ei selainta). */
function memoryStore(): KeyValueStore {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

/** Ohjattava kello (ei riippuvuutta oikeaan aikaan). */
function fixedClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('createChunkReloadGuard', () => {
  it('sallii reloadin, jos sivua ei ole ladattu äskettäin', () => {
    const guard = createChunkReloadGuard({ storage: memoryStore() });
    expect(guard.recentlyReloaded()).toBe(false);
  });

  it('estää reloadin ikkunan sisällä ja sallii sen jälkeen', () => {
    const clock = fixedClock();
    const guard = createChunkReloadGuard({
      storage: memoryStore(),
      now: clock.now,
      windowMs: 30_000,
    });

    guard.markReloaded();
    expect(guard.recentlyReloaded()).toBe(true);

    clock.advance(29_999);
    expect(guard.recentlyReloaded()).toBe(true);

    clock.advance(2);
    expect(guard.recentlyReloaded()).toBe(false);
  });

  it('clear() sallii reloadin heti uudelleen', () => {
    const guard = createChunkReloadGuard({ storage: memoryStore() });
    guard.markReloaded();
    guard.clear();
    expect(guard.recentlyReloaded()).toBe(false);
  });

  it('toimii ilman tallennusta (yksityinen tila) eikä kaadu', () => {
    const guard = createChunkReloadGuard({ storage: null });
    guard.markReloaded();
    // Ei merkintää → reload sallitaan, mutta silmukkaa ei silti synny,
    // koska markReloaded ei tallenna mitään.
    expect(guard.recentlyReloaded()).toBe(false);
    expect(() => guard.clear()).not.toThrow();
  });

  it('kestää rikkoutuneen tallennetun arvon', () => {
    const storage = memoryStore();
    storage.setItem('tampere360:chunk-reload-at', 'ei-numero');
    const guard = createChunkReloadGuard({ storage });
    expect(guard.recentlyReloaded()).toBe(false);
  });

  it('oletusikkuna on 30 sekuntia', () => {
    expect(CHUNK_RELOAD_WINDOW_MS).toBe(30_000);
  });
});
describe('chunk-retry-merkintä URL:ssa', () => {
  const BASE = 'https://d36ic5wsx4b9yl.cloudfront.net/nysse-kartta/?a=1#osa';

  it('tunnistaa merkinnän', () => {
    expect(hasChunkRetryFlag(BASE)).toBe(false);
    expect(hasChunkRetryFlag(withChunkRetryFlag(BASE))).toBe(true);
  });

  it('lisää merkinnän muiden parametrien rinnalle ja poistaa sen siististi', () => {
    const flagged = withChunkRetryFlag(BASE);
    expect(flagged).toContain(`${CHUNK_RETRY_PARAM}=1`);
    expect(flagged).toContain('a=1');
    expect(withoutChunkRetryFlag(flagged)).toBe(BASE);
  });

  it('ei muuta osoitetta, jossa ei ole merkintää', () => {
    expect(withoutChunkRetryFlag(BASE)).toBe(BASE);
  });
});

describe('recoverFromChunkError', () => {
  /** Fake-location, joka tallentaa navigoinnit (testeissä ei selainta). */
  function fakeLocation(href: string) {
    const replaced: string[] = [];
    return {
      location: {
        href,
        replace: (url: string) => replaced.push(url),
      },
      replaced,
    };
  }

  const guard = () => createChunkReloadGuard({ storage: memoryStore() });

  it('lataa sivun kerran uudelleen ja merkitsee yrityksen URL:iin', () => {
    const { location, replaced } = fakeLocation('https://example.test/kartta');

    expect(recoverFromChunkError({ guard: guard(), location })).toBe(true);
    expect(replaced).toEqual(['https://example.test/kartta?chunkRetry=1']);
  });

  it('ei lataa uudelleen toista kertaa (URL-merkintä) — tämä estää silmukan', () => {
    const { location, replaced } = fakeLocation('https://example.test/kartta?chunkRetry=1');

    expect(recoverFromChunkError({ guard: guard(), location })).toBe(false);
    expect(replaced).toEqual([]);
  });

  it('ei lataa uudelleen, jos vartija kertoo juuri tehdystä yrityksestä', () => {
    const { location, replaced } = fakeLocation('https://example.test/kartta');
    const active = guard();
    active.markReloaded();

    expect(recoverFromChunkError({ guard: active, location })).toBe(false);
    expect(replaced).toEqual([]);
  });

  it('estää silmukan myös ilman tallennusta (yksityinen tila): URL-merkintä riittää', () => {
    // Regressiosuoja 1.10.2026: pelkkä localStorage-aikaleima ei riitä, koska
    // tallennus voi olla estetty tai kello voi hypätä (selaimen virtuaaliaika)
    // → silmukka. URL-merkintä säilyy dokumentin vaihdon yli.
    const { location, replaced } = fakeLocation('https://example.test/kartta');
    const blocked = createChunkReloadGuard({ storage: null });

    expect(recoverFromChunkError({ guard: blocked, location })).toBe(true);
    expect(replaced).toEqual(['https://example.test/kartta?chunkRetry=1']);

    // "Uusi dokumentti": sama osoite + merkintä, tyhjä tallennus.
    const reloadedUrl = replaced[0];
    expect(reloadedUrl).toBeDefined();
    const afterReload = fakeLocation(reloadedUrl ?? '');
    expect(
      recoverFromChunkError({
        guard: createChunkReloadGuard({ storage: null }),
        location: afterReload.location,
      }),
    ).toBe(false);
    expect(afterReload.replaced).toEqual([]);
  });

  it('uusi virhe myöhemmin (ikkunan ulkopuolella, ilman URL-merkintää) saa taas reloadin', () => {
    const clock = fixedClock();
    const active = createChunkReloadGuard({ storage: memoryStore(), now: clock.now });
    active.markReloaded();
    clock.advance(CHUNK_RELOAD_WINDOW_MS + 1);
    const { location, replaced } = fakeLocation('https://example.test/kartta');

    expect(recoverFromChunkError({ guard: active, location })).toBe(true);
    expect(replaced).toHaveLength(1);
  });
});

describe('loadLazyModule', () => {
  /** Oletusasetukset: nopea (ei odotusta), palautusyritys oletuksena estetty. */
  function options(overrides: Partial<LazyModuleLoadOptions> = {}): LazyModuleLoadOptions {
    return {
      recover: () => false,
      delayMs: 0,
      ...overrides,
    };
  }

  it('palauttaa moduulin onnistuneella latauksella', async () => {
    const load = vi.fn(async () => ({ default: 'sivu' }));

    const result = await loadLazyModule(load, 'Kartta', options());

    expect(result).toEqual({ default: 'sivu' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('yrittää uudelleen ja onnistuu toisella kerralla ilman uudelleenlatausta', async () => {
    const load = vi
      .fn<() => Promise<{ default: string }>>()
      .mockRejectedValueOnce(new Error('TypeError: error loading dynamically imported module'))
      .mockResolvedValueOnce({ default: 'sivu' });
    const recover = vi.fn(() => true);

    await expect(loadLazyModule(load, 'Kartta', options({ recover }))).resolves.toEqual({
      default: 'sivu',
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(recover).not.toHaveBeenCalled();
  });

  it('pyytää sivun uudelleenlatausta, kun chunk ei lataudu (deployn vaihtama nimi)', async () => {
    // Regressiosuoja 27.9.2026: poistettu chunk palauttaa SPA-fallbackin
    // (index.html) → import kaatuu ("error loading dynamically imported
    // module"). Sivu on ladattava uudelleen, jotta uusi index.html osoittaa
    // olemassa oleviin chunk-nimiin.
    const load = vi.fn(() =>
      Promise.reject(new Error('error loading dynamically imported module')),
    );
    const recover = vi.fn(() => true);
    const onFailure = vi.fn();

    const pending = loadLazyModule(load, 'Nysse', options({ recover, onFailure }));
    // Palautusyritys tehdään uusintayrityksen (0 ms) jälkeen.
    await vi.waitFor(() => {
      expect(recover).toHaveBeenCalledTimes(1);
    });

    expect(load).toHaveBeenCalledTimes(2); // kaksi yritystä ennen reloadia
    expect(onFailure).toHaveBeenCalledWith('Nysse', expect.any(Error));

    // Lupaus jää odottamaan: selain lataa sivun uudelleen eikä virhe välähdä.
    const settled = await Promise.race([
      pending.then(
        () => 'ratkesi',
        () => 'hylkäsi',
      ),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('odottaa'), 20);
      }),
    ]);
    expect(settled).toBe('odottaa');
  });

  it('ei pyydä uudelleenlatausta toistuvasti — heittää ChunkLoadErrorin', async () => {
    // recover() = false tarkoittaa, että palautus on jo yritetty (URL-merkintä
    // tai aikaleima) → ei reload-silmukkaa, vaan ilmoitus.
    const recover = vi.fn(() => false);

    await expect(
      loadLazyModule(() => Promise.reject(new Error('yhä rikki')), 'Kartta', options({ recover })),
    ).rejects.toBeInstanceOf(ChunkLoadError);

    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('käsittelee tyhjän tuloksen epäonnistumisena (Viten preload-helper voi palauttaa undefined)', async () => {
    // Regressiosuoja 1.10.2026: jos `vite:preloadError` estetään, Viten
    // preload-helper ratkaisee lupauksen `undefined`illa. Ilman tätä tarkistusta
    // lazy-import näyttäisi onnistuvan ja React kaatuisi virheeseen
    // "Cannot read properties of undefined (reading 'default')".
    const load = vi.fn(async () => undefined as unknown as { default: string });
    const recover = vi.fn(() => false);

    await expect(loadLazyModule(load, 'Kartta', options({ recover }))).rejects.toBeInstanceOf(
      ChunkLoadError,
    );
    expect(load).toHaveBeenCalledTimes(2); // yritettiin uudelleen
    expect(recover).toHaveBeenCalledTimes(1); // ja yritettiin palautusta
  });

  it('ChunkLoadError kuljettaa sivun nimen ja alkuperäisen virheen', async () => {
    const original = new Error('Failed to fetch dynamically imported module');

    const error = await loadLazyModule(() => Promise.reject(original), 'Kartta', options()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ChunkLoadError);
    expect((error as ChunkLoadError).label).toBe('Kartta');
    expect((error as ChunkLoadError).cause).toBe(original);
    expect((error as ChunkLoadError).message).toContain('Kartta');
  });
});
