/**
 * Sään muotoilu ja tulkinta (§31).
 *
 * Kaikki funktiot ovat puhtaita ja palauttavat **tyhjän merkkijonon tai
 * `null`in puuttuvalle arvolle** — koskaan nollaa tai arvausta (§20).
 *
 * `describeCondition` on **oma tulkintamme** FMI:n havainnosta (pilvisyys
 * oktina + tunnin sade). Se ei ole Ilmatieteen laitoksen luokitus, minkä vuoksi
 * se kerrotaan käyttäjälle kortissa ja footterissa.
 */

/** Tilannekuvaus: emoji ja lyhyt suomenkielinen teksti. */
export interface WeatherCondition {
  emoji: string;
  label: string;
}

/** Lämpötila, esim. `12,7 °C`; tyhjä jos arvo puuttuu. */
export function formatTemperatureC(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return `${value.toFixed(1).replace('.', ',')} °C`;
}

/** Tuulen nopeus, esim. `1,6 m/s`; tyhjä jos arvo puuttuu. */
export function formatWindSpeed(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return `${value.toFixed(1).replace('.', ',')} m/s`;
}

/** Ilmanpaine, esim. `1036,4 hPa`; tyhjä jos arvo puuttuu. */
export function formatPressure(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return `${value.toFixed(1).replace('.', ',')} hPa`;
}

/**
 * Tuulen suunta suomeksi 8 lohkossa. FMI antaa suunnan **asteina siitä,
 * mistä tuuli tulee** (meteorologinen käytäntö) — siksi "pohjoisesta",
 * ei "pohjoiseen".
 */
const COMPASS_DIRECTIONS = [
  'pohjoisesta',
  'koillisesta',
  'idästä',
  'kaakosta',
  'etelästä',
  'lounaasta',
  'lännestä',
  'luoteesta',
] as const;

export function windDirectionText(deg: number | null | undefined): string {
  if (deg === null || deg === undefined || !Number.isFinite(deg)) return '';
  const normalized = ((((deg % 360) + 360) % 360) + 22.5) % 360;
  const index = Math.floor(normalized / 45) % COMPASS_DIRECTIONS.length;
  return COMPASS_DIRECTIONS[index] ?? '';
}

/**
 * Lyhyt kuvaus havainnosta (oma tulkinta). Palauttaa `null`, jos mitään
 * tulkittavaa ei ole (ei sädettä eikä pilvisyystietoa) — silloin kortti näyttää
 * vain luvut.
 */
export function describeCondition(weather: {
  cloudCoverOktas?: number | null;
  precipitation1hMm?: number | null;
  temperatureC?: number | null;
}): WeatherCondition | null {
  const precip = weather.precipitation1hMm ?? null;
  const cloud = weather.cloudCoverOktas ?? null;
  const temp = weather.temperatureC ?? null;

  if (precip !== null && precip > 0) {
    const snow = temp !== null && temp <= 0.5;
    return snow ? { emoji: '🌨️', label: 'Lumisadetta' } : { emoji: '🌧️', label: 'Sadetta' };
  }

  if (cloud === null) return null;
  if (cloud >= 7) return { emoji: '☁️', label: 'Pilvistä' };
  if (cloud >= 4) return { emoji: '⛅', label: 'Puolipilvistä' };
  if (cloud >= 1) return { emoji: '🌤️', label: 'Melko selkeää' };
  return { emoji: '☀️', label: 'Selkeää' };
}
