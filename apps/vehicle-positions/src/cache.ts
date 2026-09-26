/**
 * Muistivälimuisti ajoneuvosijainneille (arkkitehtuuri §27).
 *
 * **Miksi:** karttasivu pollaa 5 sekunnin välein. Ilman välimuistia jokainen
 * selain aiheuttaisi oman Waltti-kutsunsa (1,8 Mt XML:ää + SSM-haku +
 * jäsennys). Välimuisti pitää upstream-kutsut kurissa: N selainta → 1 kutsu
 * per TTL. Samaan aikaan saapuvat pyynnöt jakavat lisäksi yhden käynnissä
 * olevan haun (`inflight`), joten kylmäkäynnistyksen jälkeen kymmenen
 * rinnakkaista pyyntöä ei laukaise kymmentä Waltti-kutsua.
 *
 * **Virhetilanne:** jos haku epäonnistuu, palautetaan viimeisin onnistunut
 * snapshot `stale: true`na niin kauan kuin se ei ole `staleMaxMs`ia vanhempi —
 * kartta ei siis tyhjene yhden epäonnistuneen haun takia. Vasta kun
 * snapshotkin on liian vanha, virhe nostetaan kutsujalle (→ HTTP 502).
 */

export interface CachedSnapshot<T> {
  value: T;
  /** true = upstream-haku epäonnistui, tarjolla on vanhempi snapshot. */
  stale: boolean;
  /** Snapshotin hakuaika (ms epoch). */
  fetchedAt: number;
}

export interface SnapshotCacheOptions<T> {
  /** Kuinka kauan snapshotia käytetään ilman uutta upstream-kutsua. */
  ttlMs: number;
  /** Kuinka vanha snapshot kelpaa vielä virhetilanteessa. */
  staleMaxMs: number;
  now: () => number;
  load: () => Promise<T>;
}

export interface SnapshotCache<T> {
  get: () => Promise<CachedSnapshot<T>>;
}

export function createSnapshotCache<T>(options: SnapshotCacheOptions<T>): SnapshotCache<T> {
  let entry: { value: T; fetchedAt: number } | null = null;
  let inflight: Promise<T> | null = null;

  function refresh(): Promise<T> {
    if (!inflight) {
      inflight = options.load().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  return {
    async get(): Promise<CachedSnapshot<T>> {
      if (entry && options.now() - entry.fetchedAt < options.ttlMs) {
        return { value: entry.value, stale: false, fetchedAt: entry.fetchedAt };
      }

      try {
        const value = await refresh();
        entry = { value, fetchedAt: options.now() };
        return { value, stale: false, fetchedAt: entry.fetchedAt };
      } catch (error) {
        if (entry && options.now() - entry.fetchedAt <= options.staleMaxMs) {
          return { value: entry.value, stale: true, fetchedAt: entry.fetchedAt };
        }
        throw error;
      }
    },
  };
}
