/**
 * Saunojen muotoilu ja päivän aukiolon/hintojen valinta (arkkitehtuuri §33).
 *
 * Kaikki funktiot ovat **puhtaita** (ei verkkoa eikä Reactia), jotta logiikka on
 * yksikkötestattavissa ilman selainta. Verkkohaku on `api/saunas.ts`:ssä.
 *
 * Keskeiset periaatteet:
 *  - "Tänään" lasketaan **aina Suomen ajassa** (`HELSINKI_TIME_ZONE`), koska
 *    saunat ovat suomalaisia (§20: selaimen aikavyöhyke ei saa muuttaa tätä).
 *  - Puuttuvaa ei arvata: jos lähde ei kerro aukioloa tai hintaa, se näytetään
 *    puuttuvana, ei nollana.
 */

import type { Sauna, SaunaOpeningHours } from '../api/saunas';
import { HELSINKI_TIME_ZONE } from './format';

/** Viikonpäivät lähteen enumina, maanantaista. */
export const SAUNA_WEEKDAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;

export type SaunaWeekday = (typeof SAUNA_WEEKDAYS)[number];

const WEEKDAY_LABELS: Record<SaunaWeekday, string> = {
  MONDAY: 'maanantai',
  TUESDAY: 'tiistai',
  WEDNESDAY: 'keskiviikko',
  THURSDAY: 'torstai',
  FRIDAY: 'perjantai',
  SATURDAY: 'lauantai',
  SUNDAY: 'sunnuntai',
};

/** Suomenkielinen viikonpäivän nimi, esim. `lauantai`. */
export function weekdayLabel(weekday: SaunaWeekday): string {
  return WEEKDAY_LABELS[weekday];
}

/**
 * Tämänhetkinen viikonpäivä lähteen enumina **Suomen ajassa**.
 *
 * Käytetään `Intl.DateTimeFormat`ia eikä `Date.getDay()`ia, koska jälkimmäinen
 * käyttäisi selaimen aikavyöhykettä — UTC-selain (tai ulkomailla oleva käyttäjä)
 * valitsisi silloin väärän päivän aukiolon.
 */
export function todayWeekday(now: Date = new Date()): SaunaWeekday {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: HELSINKI_TIME_ZONE,
    weekday: 'long',
  })
    .format(now)
    .toUpperCase();
  return (SAUNA_WEEKDAYS as readonly string[]).includes(name) ? (name as SaunaWeekday) : 'MONDAY';
}

/** Kello `HH:MM:SS` / `HH:MM` → `HH.MM`; tyhjä jos muoto ei täsmää. */
export function formatClock(value: string | null | undefined): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value ?? '').trim());
  const hours = match?.[1];
  const minutes = match?.[2];
  if (!hours || !minutes) return '';
  return `${hours.padStart(2, '0')}.${minutes}`;
}

/** Yhden jakson aukiolo, esim. `14.00–21.45`; tyhjä jos kellonajat puuttuvat. */
export function formatSession(session: SaunaOpeningHours): string {
  const opening = formatClock(session.openingTime);
  const closing = formatClock(session.closingTime);
  if (!opening || !closing) return '';
  return `${opening}–${closing}`;
}

/** Päivän kaikki jaksot, esim. `08.00–12.00, 16.00–22.00`. */
export function formatSessions(sessions: SaunaOpeningHours[]): string {
  return sessions.map(formatSession).filter(Boolean).join(', ');
}

/** Päivän aukiolojaksot (voi olla useita, esim. aamu ja ilta). */
export function todaysSessions(sauna: Sauna, weekday: SaunaWeekday): SaunaOpeningHours[] {
  return (sauna.openingHours ?? []).filter((entry) => entry.weekday === weekday);
}

/**
 * Aukiolon tila tänään -teksti:
 *  - päivällä on jaksoja → `12.00–21.45` (tai useampi pilkulla erotettuna)
 *  - saunalla on aukioloja mutta ei tänään → `Ei aukioloa tänään`
 *  - saunalla ei ole yhtään aukioloa (esim. remontissa) → `Ei aukioloaikoja`
 */
export function saunaTodayStatus(sauna: Sauna, weekday: SaunaWeekday): string {
  const sessions = todaysSessions(sauna, weekday);
  if (sessions.length > 0) return formatSessions(sessions);
  return (sauna.openingHours?.length ?? 0) > 0 ? 'Ei aukioloa tänään' : 'Ei aukioloaikoja';
}

/** Onko sauna auki tänään (vähintään yksi jakso tälle päivälle). */
export function isOpenToday(sauna: Sauna, weekday: SaunaWeekday): boolean {
  return todaysSessions(sauna, weekday).length > 0;
}

/**
 * Aukiolon sävy: `open` = auki tänään (vihreä), `closed` = ei auki tänään
 * (punainen). Kattaa molemmat suljetut tilat: sekä "Ei aukioloa tänään" että
 * "Ei aukioloaikoja" (esim. remontti).
 */
export type SaunaTodayTone = 'open' | 'closed';

export function saunaTodayTone(sauna: Sauna, weekday: SaunaWeekday): SaunaTodayTone {
  return isOpenToday(sauna, weekday) ? 'open' : 'closed';
}

/** Hintaluokan suomenkielinen nimi. `CONSRIPT` on lähteen kirjoitusasu. */
const PRICE_TYPE_LABELS: Record<string, string> = {
  ADULT: 'Aikuinen',
  CHILD: 'Lapsi',
  STUDENT: 'Opiskelija',
  PENSIONER: 'Eläkeläinen',
  UNEMPLOYED: 'Työtön',
  CONSRIPT: 'Varusmies',
};

/** Hintaluokka suomeksi; tuntematon luokka näytetään siistittynä sellaisenaan. */
export function priceTypeLabel(priceType: string): string {
  const key = String(priceType ?? '')
    .trim()
    .toUpperCase();
  if (!key) return 'Hinta';
  const known = PRICE_TYPE_LABELS[key];
  if (known) return known;
  return key.charAt(0) + key.slice(1).toLowerCase();
}

/** Hinta suomalaisella desimaalierottimella, esim. `8 €` tai `11,70 €`. */
export function formatPrice(price: number): string {
  if (!Number.isFinite(price)) return '';
  const rounded = Math.round(price * 100) / 100;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace('.', ',');
  return `${text} €`;
}

export interface SaunaPriceView {
  priceType: string;
  label: string;
  price: number;
}

/**
 * Saunan hinnat.
 *
 * Ensisijaisesti **päivän** jaksojen hinnat (se mitä käyttäjä tarvitsee juuri
 * nyt). Jos tänään ei ole aukioloa, näytetään koko viikon hinnat, jotta hinta ei
 * katoa. Samat `(luokka, hinta)`-parit näytetään vain kerran.
 */
export function saunaPrices(sauna: Sauna, weekday: SaunaWeekday): SaunaPriceView[] {
  const today = todaysSessions(sauna, weekday);
  const source = today.length > 0 ? today : (sauna.openingHours ?? []);

  const seen = new Set<string>();
  const result: SaunaPriceView[] = [];
  for (const session of source) {
    for (const price of session.prices ?? []) {
      const key = `${price.priceType}:${price.price}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        priceType: price.priceType,
        label: priceTypeLabel(price.priceType),
        price: price.price,
      });
    }
  }
  return result;
}

/** Osoite muodossa `Urheilukatu 20, 37600 Valkeakoski`. */
export function formatAddress(sauna: Sauna): string {
  const street = (sauna.streetAddress ?? '').trim();
  const postalAndCity = [sauna.postalCode, sauna.city]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(' ');
  return [street, postalAndCity].filter(Boolean).join(', ');
}

/**
 * Järjestää saunat listalle:
 *
 *  1. **Tänään auki olevat ensin**, niiden jälkeen tänään suljetut. Näin
 *     käyttäjä näkee heti ne saunat, joihin voi mennä nyt.
 *  2. Kummankin ryhmän sisällä **aakkosjärjestys nimen mukaan** (suomalainen
 *     aakkosjärjestys: ä/ö aakkostuvat oikein `localeCompare`illa).
 *
 * Palauttaa uuden taulukon (ei mutatoi alkuperäistä).
 */
export function sortSaunas(saunas: Sauna[], weekday: SaunaWeekday): Sauna[] {
  return [...saunas].sort((a, b) => {
    const aOpen = isOpenToday(a, weekday);
    const bOpen = isOpenToday(b, weekday);
    if (aOpen !== bOpen) return aOpen ? -1 : 1;

    return (a.name ?? '').localeCompare(b.name ?? '', 'fi');
  });
}
