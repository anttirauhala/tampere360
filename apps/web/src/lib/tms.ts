/**
 * Liikennemäärät-sivun puhtaat apurit (arkkitehtuuri §30).
 *
 * Kaikki käyttäjälle näkyvä muotoilu on täällä, jotta se on testattavissa ilman
 * DOMia. Periaatteet:
 *
 *  - **puuttuva tieto näytetään viivana** (`—`), ei nollana eikä arvauksena
 *  - **sujuvuusluokka on oma arviomme** (nopeus / vapaa nopeus), joten se
 *    kerrotaan tekstinä eikä pelkkänä värinä
 *  - **luvut suomalaisittain**: tuhaterotin välilyönti, desimaalierotin pilkku
 */

import type { DirectionSnapshot, FlowLevel, StationSnapshot } from '../api/tms';

/** Mihin tahansa puuttuvaan arvoon tulostetaan tämä. */
export const MISSING_VALUE = '—';

const numberFormat = new Intl.NumberFormat('fi-FI');
const decimalFormat = new Intl.NumberFormat('fi-FI', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Sujuvuusluokan suomenkielinen selite. */
export function flowLevelLabel(level: FlowLevel): string {
  switch (level) {
    case 'SUJUVAA':
      return 'Sujuvaa';
    case 'HIDASTUNUT':
      return 'Hidastunutta';
    case 'RUUHKAUTUNUT':
      return 'Ruuhkautunut';
    default:
      return 'Ei tietoa';
  }
}

/** Sujuvuusluokan CSS-luokka (väri tulee tyylitiedostosta). */
export function flowLevelClass(level: FlowLevel): string {
  return `tms-level--${level.toLowerCase()}`;
}

/** Kokonaisluku suomalaisella tuhaterottimella. */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING_VALUE;
  return numberFormat.format(value);
}

/** Nopeus km/h (yksi desimaali vain, jos arvo ei ole kokonainen). */
export function formatSpeed(speed: number | null | undefined): string {
  if (speed === null || speed === undefined || !Number.isFinite(speed)) return MISSING_VALUE;
  const value = Number.isInteger(speed) ? numberFormat.format(speed) : decimalFormat.format(speed);
  return `${value} km/h`;
}

/** Liikennemäärä ajoneuvoa tunnissa. */
export function formatVolume(volume: number | null | undefined): string {
  if (volume === null || volume === undefined || !Number.isFinite(volume)) return MISSING_VALUE;
  return `${formatNumber(volume)} ajoneuvoa/h`;
}

/** Vapaan ajon nopeus vertailuarvona. */
export function formatFreeFlow(speed: number | null | undefined): string {
  if (speed === null || speed === undefined || !Number.isFinite(speed)) return MISSING_VALUE;
  return `${numberFormat.format(speed)} km/h`;
}

/** Suunnan kuvaus: `Suunta 1 · Lahti` (tai ilman määränpäätä). */
export function describeDirection(direction: DirectionSnapshot): string {
  return direction.municipality
    ? `Suunta ${direction.direction} · ${direction.municipality}`
    : `Suunta ${direction.direction}`;
}

/** Suhteellinen sujuvuus prosentteina (esim. 78 %), tai `—`. */
export function formatSpeedRatio(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return MISSING_VALUE;
  return `${Math.round(ratio * 100)} % vapaasta nopeudesta`;
}

/**
 * Palkkien korkeudet prosentteina suurimmasta arvosta.
 *
 * `null`-arvot jäävät nollakorkuisiksi ja tyhjät sarjat palauttavat nollat —
 * kuvaaja ei siis koskaan näytä keksittyä palkkia. Pienin näkyvä korkeus on
 * 2 %, jotta nollasta poikkeava arvo erottuu nollasta.
 */
export function barHeights(values: (number | null)[]): number[] {
  const numbers = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  const max = numbers.length > 0 ? Math.max(...numbers) : 0;
  if (max <= 0) return values.map(() => 0);

  return values.map((value) => {
    if (value === null || !Number.isFinite(value) || value <= 0) return 0;
    return Math.max(2, Math.round((value / max) * 100));
  });
}

/** Tuntiväli tekstinä: `08–09`. */
export function hourLabel(hour: number): string {
  const start = String(((hour % 24) + 24) % 24).padStart(2, '0');
  const end = String(((((hour % 24) + 24) % 24) + 1) % 24).padStart(2, '0');
  return `${start}–${end}`;
}

/** Lyhyt päivämäärä palkin alle: `13.9.` */
export function dayLabel(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const [, , month, day] = match;
  return `${Number(day)}.${Number(month)}.`;
}

/** Kuukausi tekstinä: `syyskuu 2026`. */
export function monthLabel(iso: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const [, year, month] = match;
  const names = [
    'tammikuu',
    'helmikuu',
    'maaliskuu',
    'huhtikuu',
    'toukokuu',
    'kesäkuu',
    'heinäkuu',
    'elokuu',
    'syyskuu',
    'lokakuu',
    'marraskuu',
    'joulukuu',
  ];
  const name = names[Number(month) - 1];
  return name ? `${name} ${year}` : iso;
}

/** Aseman sijaintiteksti: `Tampere · tie 12`. */
export function stationLocationText(station: StationSnapshot): string {
  const road = station.road ? `tie ${station.road.replace(/^[a-z]+/i, '')}` : null;
  const text = [station.municipality, road]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
  return text || MISSING_VALUE;
}

/** Onko asemalla vähintään yksi ruuhkautunut suunta? */
export function isCongested(station: StationSnapshot): boolean {
  return station.directions.some((direction) => direction.level === 'RUUHKAUTUNUT');
}

/**
 * Mittauksen ikä tekstinä: `mitattu hetki sitten`, `mitattu 3 min sitten`,
 * `mitattu 1 h 20 min sitten`. Ikä on laskettu lähteen omasta aikaleimasta.
 */
export function measuredAgeText(ageMinutes: number | null | undefined): string {
  if (ageMinutes === null || ageMinutes === undefined || !Number.isFinite(ageMinutes)) {
    return 'mittausaika ei tiedossa';
  }
  if (ageMinutes < 1) return 'mitattu hetki sitten';
  if (ageMinutes < 60) return `mitattu ${Math.round(ageMinutes)} min sitten`;
  const hours = Math.floor(ageMinutes / 60);
  const minutes = Math.round(ageMinutes % 60);
  return minutes > 0 ? `mitattu ${hours} h ${minutes} min sitten` : `mitattu ${hours} h sitten`;
}
