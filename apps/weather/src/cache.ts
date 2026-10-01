/**
 * Avainkohtainen muistivälimuisti (arkkitehtuuri §31).
 *
 * Sama malli kuin mittausasemissa (§30): N selainta aiheuttaa enintään yhden
 * FMI-kutsun per TTL per lämmin kontti. Tämä on tärkeää, koska FMI:n WFS:llä
 * on pyyntörajat (10 000/vrk, 600 / 5 min) — ilman välimuistia jokainen avoin
 * selain tekisi oman kutsunsa 5 minuutin välein.
 *
 * Samaan aikaan saapuvat saman avaimen pyynnöt jakavat yhden käynnissä olevan
 * haun (`inflight`). Virhetilanteessa palautetaan viimeisin onnistunut arvo
 * `stale: true`na niin kauan kuin se ei ole `staleMaxMs`ia vanhempi — sääkortti
 * ei siis tyhjene yhden epäonnistuneen haun takia.
 */

export interface CachedValue<T> {
  value: T;
  /** true = upstream-haku epäonnistui, tarjolla on vanhempi arvo. */
  stale: boolean;
  /** Arvon hakuaika (ms epoch). */
  fetchedAt: number;
}

export interface KeyedCacheOptions {
  /** Kuinka kauan arvoa käytetään ilman uutta upstream-kutsua. */
  ttlMs: number;
  /** Kuinka vanha arvo kelpaa vielä virhetilanteessa. */
  staleMaxMs: number;
  /** Enimmäismäärä avaimia muistissa (vanhin poistetaan tarvittaessa). */
  maxEntries: number;
  now: () => number;
}

export interface KeyedCache<T> {
  /** Hakee arvon (tarvittaessa upstreamista) ja päivittää välimuistin. */
  get: (key: string, load: () => Promise<T>) => Promise<CachedValue<T>>;
  /** Lukee arvon vain jos se on jo muistissa — ei koskaan laukaise hakua. */
  peek: (key: string) => T | null;
}

export function createKeyedCache<T>(options: KeyedCacheOptions): KeyedCache<T> {
  const entries = new Map<string, { value: T; fetchedAt: number }>();
  const inflight = new Map<string, Promise<T>>();

  function store(key: string, value: T, fetchedAt: number): void {
    // Map säilyttää lisäysjärjestyksen → ensimmäinen avain on vanhin.
    entries.delete(key);
    entries.set(key, { value, fetchedAt });
    while (entries.size > options.maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  function refresh(key: string, load: () => Promise<T>): Promise<T> {
    const existing = inflight.get(key);
    if (existing) return existing;

    const pending = load().finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, pending);
    return pending;
  }

  return {
    async get(key: string, load: () => Promise<T>): Promise<CachedValue<T>> {
      const now = options.now();
      const entry = entries.get(key);
      if (entry && now - entry.fetchedAt < options.ttlMs) {
        return { value: entry.value, stale: false, fetchedAt: entry.fetchedAt };
      }

      try {
        const value = await refresh(key, load);
        const fetchedAt = options.now();
        store(key, value, fetchedAt);
        return { value, stale: false, fetchedAt };
      } catch (error) {
        if (entry && options.now() - entry.fetchedAt <= options.staleMaxMs) {
          return { value: entry.value, stale: true, fetchedAt: entry.fetchedAt };
        }
        throw error;
      }
    },

    peek(key: string): T | null {
      return entries.get(key)?.value ?? null;
    },
  };
}
