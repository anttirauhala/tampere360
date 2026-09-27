/**
 * Avainkohtainen muistivälimuisti (arkkitehtuuri §28).
 *
 * **Miksi kaksi eri cachea samalla toteutuksella:**
 *  - reaaliaikaiset lähdöt: avain = pysäkkitunniste, TTL 15 s (§28 kohta 6)
 *  - staattinen pysäkkirekisteri: avain = `'gtfs'`, TTL tunteja (§28 kohta 7)
 *
 * Nämä eivät saa sekoittua toisiinsa, joten ne ovat kaksi erillistä
 * `createKeyedCache`-instanssia omilla TTL-arvoillaan.
 *
 * Samanaikaiset saman avaimen pyynnöt jakavat yhden käynnissä olevan haun
 * (`inflight`), joten N rinnakkaista selainta ei laukaise N:ää Waltti-kutsua.
 * Virhetilanteessa palautetaan viimeisin onnistunut arvo `stale: true`na niin
 * kauan kuin se ei ole `staleMaxMs`ia vanhempi — pysäkkimonitori ei siis
 * tyhjene yhden epäonnistuneen haun takia.
 *
 * Muisti on rajattu (`maxEntries`), koska Lambda-kontti elää tuntikausia ja
 * pysäkkejä voi kysyä tuhansia: ilman rajaa kartta selatessa kertyisi
 * rajattomasti välimuistirivejä.
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
  /**
   * Kuinka kauan epäonnistumisen jälkeen samalle avaimelle **ei** tehdä uutta
   * upstream-kutsua, jos käytettävissä ei ole vanhaa arvoa (`0` = ei jäähdytystä).
   *
   * **Miksi:** Waltti vastaa 500:lla pysäkeille, joita sen reaaliaikarekisterissä
   * ei ole (ks. `coverage.ts`). Ilman jäähdytystä jokainen selaimen 15 sekunnin
   * pollaus aiheuttaisi kaksi uutta yritystä (`retry.ts`) — jäähdytys rajaa sen
   * yhteen yrityssarjaan minuutissa. Jäähdytys on lyhyt, joten pysäkin tiedot
   * alkavat näkyä itsestään heti, kun lähde ne palauttaa.
   */
  failureCooldownMs?: number;
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
      const entry = entries.get(key);
      if (entry && options.now() - entry.fetchedAt < options.ttlMs) {
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
