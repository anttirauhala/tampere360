/**
 * Pysäkkien ja lähtöjen esityslogiikka (§28).
 *
 * Puhtaita funktioita (ei verkkoa eikä Reactia), jotta ne ovat
 * yksikkötestattavissa ilman selainta — sama periaate kuin `lib/vehicles.ts`.
 */

import type { Stop, StopDeparture, StopFeature, StopFeatureCollection } from '../api/types';
import { HELSINKI_TIME_ZONE } from './format';

/** Pysäkki kartan GeoJSON-featuresta sidepanelia varten. */
export function stopFromFeature(feature: StopFeature): Stop {
  const [longitude, latitude] = feature.geometry.coordinates;
  return {
    id: feature.properties.id,
    name: feature.properties.name,
    latitude,
    longitude,
  };
}

/**
 * Pysäkkihakemisto tunnisteen mukaan (sidepanelin nimen hakua varten).
 *
 * Kartan klikkaus antaa vain tunnisteen, joten nimi haetaan tästä — ilman
 * hakemistoa jokainen klikkaus olisi pitänyt hakea erikseen API:sta.
 */
export function buildStopIndex(
  collection: StopFeatureCollection | null | undefined,
): Map<string, Stop> {
  const index = new Map<string, Stop>();
  for (const feature of collection?.features ?? []) {
    if (!feature.properties?.id) continue;
    index.set(feature.properties.id, stopFromFeature(feature));
  }
  return index;
}

/** Aika, jolla lähtö tapahtuu: ennuste ensin, sitten aikataulu. */
export function departureTimeMs(departure: StopDeparture): number | null {
  for (const candidate of [departure.expectedTime, departure.scheduledTime]) {
    if (!candidate) continue;
    const timestamp = Date.parse(candidate);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

/**
 * Kuinka monta minuuttia lähtöön on. `null`, jos aikaa ei tiedetä; 0 tai
 * negatiivinen tarkoittaa "juuri nyt" (vuoro on pysäkillä).
 */
export function departureMinutes(
  departure: StopDeparture,
  now: number = Date.now(),
): number | null {
  const time = departureTimeMs(departure);
  if (time === null) return null;
  return Math.round((time - now) / 60_000);
}

/** Sävy lähtörivin tyylittelyyn (ks. `styles.css` → "Pysäkin sidepanel"). */
export type DepartureTone = 'now' | 'soon' | 'later';

/**
 * Sävy minuuttien mukaan. Sama kynnys kuin `formatDepartureIn`issa, jotta väri
 * ja teksti eivät voi kertoa eri asiaa (sama periaate kuin `delayTone` §27:ssä).
 */
export function departureTone(departure: StopDeparture, now: number = Date.now()): DepartureTone {
  const minutes = departureMinutes(departure, now);
  if (minutes === null || minutes <= 0) return 'now';
  return minutes <= 3 ? 'soon' : 'later';
}

/**
 * Lähtöaika luettavana tekstinä: `nyt`, `2 min`, `14 min`.
 *
 * Aikatauluvuorot (ei reaaliaikaista seurantaa) merkitään `≈`-etuliitteellä,
 * koska niiden aika on aikataulun mukainen arvio eikä havaintoon perustuva
 * ennuste. Ilman aikaa näytetään `–` (aikaleimoja ei arvata, §20).
 */
export function formatDepartureIn(departure: StopDeparture, now: number = Date.now()): string {
  const minutes = departureMinutes(departure, now);
  if (minutes === null) return '–';
  const prefix = departure.realtime ? '' : '≈ ';
  if (minutes <= 0) return `${prefix}nyt`;
  return `${prefix}${minutes} min`;
}

/**
 * Kellonaika ilman päivämäärää (esim. `12.34.20`) sidepanelin alatunnisteeseen.
 * Aikavyöhyke on aina Suomen aika, kuten muualla sovelluksessa.
 */
export function formatClockTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('fi-FI', {
    timeZone: HELSINKI_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Onko listalla aikatauluarvioita (näytetään selite `≈`-merkille vain tarvittaessa). */
export function hasEstimates(departures: StopDeparture[]): boolean {
  return departures.some((departure) => !departure.realtime);
}

/**
 * Huomautus, kun Waltti ei palauta pysäkille aikatauluja lainkaan
 * (`realtimeCoverage: false`).
 *
 * Tämä ei ole virhe: pysäkki on olemassa ja näkyy kartalla, mutta sen
 * reaaliaikaisia lähtöjä ei ole lähdetiedoissa. Siksi teksti on neutraali eikä
 * kehota yrittämään uudelleen (uusi yritys ei muuta tilannetta).
 */
export const NO_REALTIME_COVERAGE_TEXT =
  'Waltti ei tarjoa tälle pysäkille lähtötietoja, joten reaaliaikaista aikataulua ei ole näytettävissä.';

/** Huomautuksen sävy: `error` = virhe, `info` = tiedoksi. */
export interface DeparturesNotice {
  tone: 'error' | 'info';
  text: string;
}

/**
 * Muuttaa lähtötietojen hakuvirheen käyttäjälle luettavaksi huomautukseksi.
 *
 * **Miksi tilakoodi eikä virheteksti:** pysäkkimonitorissa 5xx tarkoittaa, että
 * lähde (Waltti) ei vastannut — se on tilapäinen ja korjautuu itsestään, joten
 * käyttäjälle ei näytetä teknistä `API-virhe 503` -tekstiä vaan rauhallinen
 * huomautus. 4xx puolestaan on pysyvä virhe.
 *
 * `status === null` tarkoittaa, ettei virhe tullut API:sta lainkaan (esim.
 * verkko katkesi selaimessa).
 */
export function stopDeparturesNotice(status: number | null): DeparturesNotice {
  if (status !== null && status >= 500) {
    return {
      tone: 'error',
      text: 'Lähtötietoja ei juuri nyt saada tälle pysäkille — lähde (Waltti) ei vastannut. Yritämme uudelleen automaattisesti.',
    };
  }
  if (status === 404) {
    return { tone: 'error', text: 'Tälle pysäkille ei löytynyt lähtötietoja.' };
  }
  if (status !== null) {
    return { tone: 'error', text: `Lähtötietojen haku epäonnistui (virhe ${status}).` };
  }
  return {
    tone: 'error',
    text: 'Lähtötietojen haku epäonnistui — tarkista verkkoyhteytesi. Yritämme uudelleen automaattisesti.',
  };
}
