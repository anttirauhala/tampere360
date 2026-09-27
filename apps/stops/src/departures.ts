/**
 * Pysäkin lähtölistan rakentaminen SIRI-vuoroista (arkkitehtuuri §28).
 *
 * SIRI antaa pysäkille **kaikki** sen kautta kulkevat vuorot, myös ne jotka ovat
 * jo menneet ja ne jotka lähtevät tunnin päästä. Lista siivotaan täällä:
 *
 *  1. lähtöajaksi valitaan ennuste (`ExpectedDepartureTime`), sitten aikataulu
 *     (`AimedDepartureTime`) ja vasta viimeisenä saapumisaika — aikaleimoja ei
 *     koskaan arvata (§20), mutta olemassa olevista valitaan tarkin
 *  2. menneet lähdöt pudotetaan pois pientä armoväliä lukuun ottamatta
 *     (juuri lähtenyt vuoro saa kadota vasta kun tieto on vanhentunut)
 *  3. vuoro, jonka lähde kertoo olevan **pysäkillä juuri nyt**
 *     (`VehicleAtStop`), pidetään listalla ajasta riippumatta — se on
 *     käyttäjälle listan tärkein rivi
 *  4. lista järjestetään lähtöajan mukaan ja katkaistaan (`limit`)
 */

import type { SiriStopVisit, StopDeparture } from './types';

/** Kuinka monta lähtöä enintään palautetaan (sidepanelin lista). */
export const DEPARTURE_LIMIT = 20;

/**
 * Armoväli menneille lähdöille. SIRI päivittyy 30 sekunnin välein, joten
 * täsmälleen nyt lähtevä vuoro voi näyttää hetken "menneeltä".
 */
export const DEPARTURE_GRACE_MS = 30_000;

/** Lähtöaika millisekunteina: ennuste → aikataulu → saapumisaika. */
export function departureTimeMs(visit: SiriStopVisit): number | null {
  const candidates = [
    visit.expectedDepartureTime,
    visit.aimedDepartureTime,
    visit.expectedArrivalTime,
    visit.aimedArrivalTime,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const timestamp = Date.parse(candidate);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

export interface BuildDeparturesOptions {
  /** Nykyhetki millisekunteina (annetaan parametrina, jotta testi on deterministinen). */
  now: number;
  /** Enimmäismäärä palautettavia lähtöjä. Oletus: DEPARTURE_LIMIT. */
  limit?: number;
  /** Armoväli menneille lähdöille. Oletus: DEPARTURE_GRACE_MS. */
  graceMs?: number;
}

/** Rakentaa pysäkin lähtölistan (ks. tiedoston yläkommentti). */
export function buildStopDepartures(
  visits: SiriStopVisit[],
  options: BuildDeparturesOptions,
): StopDeparture[] {
  const limit = options.limit ?? DEPARTURE_LIMIT;
  const graceMs = options.graceMs ?? DEPARTURE_GRACE_MS;
  const earliest = options.now - graceMs;

  return visits
    .map((visit) => ({ visit, time: departureTimeMs(visit) }))
    .filter((entry): entry is { visit: SiriStopVisit; time: number } => entry.time !== null)
    .filter((entry) => entry.time >= earliest || entry.visit.vehicleAtStop)
    .sort(
      (a, b) =>
        a.time - b.time || a.visit.line.localeCompare(b.visit.line, 'fi', { numeric: true }),
    )
    .slice(0, limit)
    .map(({ visit }) => ({
      routeShortName: visit.line,
      destination: visit.destination,
      scheduledTime: visit.aimedDepartureTime ?? visit.aimedArrivalTime,
      expectedTime: visit.expectedDepartureTime ?? visit.expectedArrivalTime,
      // Poikkeama näytetään vain reaaliaikaisesta vuorosta: ilman seurantaa
      // lähde antaa `Delay`-kentän, jonka arvo ei perustu havaintoon.
      delaySeconds: visit.realtime ? visit.delaySeconds : null,
      realtime: visit.realtime,
    }));
}
