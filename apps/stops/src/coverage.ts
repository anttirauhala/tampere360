/**
 * Pysäkkikohtainen "ei reaaliaikapeittoa" -tunnistus (arkkitehtuuri §28,
 * vianetsintä 27.9.2026).
 *
 * **Miksi tämä on olemassa:** Walttin SIRI StopMonitoring -yhdyskäytävä vastaa
 * HTTP 500:lla ("Something went wrong") pysäkeille, joita sen
 * reaaliaikarekisterissä ei ole. Tämä ei ole tilapäinen virhe vaan pysyvä ominaisuus:
 * satunnaisotannassa 27.9.2026 **2 / 60 pysäkkiä** (6833, 6837) vastasi 500 myös
 * 24 tunnin `PreviewInterval`illa, kun taas tuntemattoman muotoiset tunnisteet
 * (`9999`, `HQ:1`) käyttäytyivät samoin. Waltti ei kerro syytä erikseen (runko on
 * aina `Something went wrong`), eikä SIRI-tason pysäkkirekisteriä
 * (`StopPointsDiscovery`) ole tässä yhdyskäytävässä käytettävissä — se vastaa 500.
 *
 * Koska syytä ei voi lukea vastauksesta, se **opitaan** toistuvista virheistä:
 *
 *   1. peräkkäisiä epäonnistumisia tarvitaan `failureThreshold` kappaletta
 *   2. ne täytyy saada `failureWindowMs`-ikkunan sisällä (muuten laskuri nollautuu)
 *   3. **jokin toinen pysäkki on täytynyt onnistua** samana aikana — muuten kyse on
 *      koko lähteen katkoksesta, ei yksittäisestä pysäkistä
 *
 * Merkinnän jälkeen pysäkille ei enää soiteta Walttiin `uncoveredTtlMs`-aikaan,
 * vaan palautetaan rehellinen "ei reaaliaikatietoja" -vastaus. Merkintä vanhenee
 * itsestään, joten tilanne korjautuu ilman uudelleenkäynnistystä, jos Waltti
 * myöhemmin alkaa palauttaa pysäkin tiedot.
 *
 * Onnistunut haku pyyhkii laskurin heti: yksi hyvä vastaus riittää siihen, että
 * pysäkkiä ei merkitä.
 */

export interface StopCoverageOptions {
  /** Kuinka monta peräkkäistä epäonnistumista tarvitaan merkintään. */
  failureThreshold: number;
  /** Ikkuna, jonka sisällä epäonnistumisten täytyy tapahtua (ms). */
  failureWindowMs: number;
  /** Kuinka kauan merkintä on voimassa (ms) ennen uutta yritystä. */
  uncoveredTtlMs: number;
  /** Enimmäismäärä pysäkkejä muistissa (vanhin poistetaan tarvittaessa). */
  maxEntries: number;
  now: () => number;
}

export interface StopCoverage {
  /** Kirjaa epäonnistumisen; `true` = pysäkki merkittiin juuri nyt ilman peittoa. */
  recordFailure: (stopId: string) => boolean;
  /** Kirjaa onnistumisen: laskuri nollautuu ja merkintä poistuu. */
  recordSuccess: (stopId: string) => void;
  /** Onko pysäkillä voimassa oleva "ei reaaliaikapeittoa" -merkintä. */
  isUncovered: (stopId: string) => boolean;
}

interface CoverageEntry {
  failures: number;
  /** Ensimmäisen laskentaan mukaan otetun epäonnistumisen aika. */
  firstFailureAt: number;
  /** Merkinnän aika tai `null`, jos pysäkkiä ei ole merkitty. */
  markedAt: number | null;
}

export function createStopCoverageTracker(options: StopCoverageOptions): StopCoverage {
  const entries = new Map<string, CoverageEntry>();
  /** Viimeisin **minkä tahansa** pysäkin onnistunut haku. */
  let lastSuccessAt = Number.NEGATIVE_INFINITY;

  function trim(): void {
    while (entries.size > options.maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  function forget(stopId: string): void {
    entries.delete(stopId);
  }

  return {
    recordFailure(stopId: string): boolean {
      const now = options.now();
      const previous = entries.get(stopId);

      // Merkintä on vanhentunut → lasketaan alusta.
      if (
        previous &&
        previous.markedAt !== null &&
        now - previous.markedAt >= options.uncoveredTtlMs
      ) {
        forget(stopId);
      }
      // Edellinen laskenta on liian vanha → ei lasketa samaan sarjaan.
      const stale = entries.get(stopId);
      if (
        stale &&
        stale.markedAt === null &&
        now - stale.firstFailureAt > options.failureWindowMs
      ) {
        forget(stopId);
      }

      const entry: CoverageEntry = entries.get(stopId) ?? {
        failures: 0,
        firstFailureAt: now,
        markedAt: null,
      };
      entry.failures += 1;

      // Map säilyttää lisäysjärjestyksen → tuorein avain viimeiseksi.
      forget(stopId);
      entries.set(stopId, entry);
      trim();

      if (entry.markedAt !== null) return false;
      if (entry.failures < options.failureThreshold) return false;
      // Koko lähde on alhaalla (yksikään pysäkki ei ole vastannut tänä aikana)
      // → vika ei ole tässä pysäkissä.
      if (lastSuccessAt < entry.firstFailureAt) return false;

      entry.markedAt = now;
      return true;
    },

    recordSuccess(stopId: string): void {
      forget(stopId);
      lastSuccessAt = options.now();
    },

    isUncovered(stopId: string): boolean {
      const entry = entries.get(stopId);
      if (!entry || entry.markedAt === null) return false;
      if (options.now() - entry.markedAt >= options.uncoveredTtlMs) {
        forget(stopId);
        return false;
      }
      return true;
    },
  };
}
