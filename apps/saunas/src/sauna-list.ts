/**
 * Saunahaku.fi-rajapinnan haku ja normalisointi (arkkitehtuuri §33).
 *
 * Rajapinta (verifioitu 1.10.2026):
 *   `GET https://08aapg0u7e.execute-api.eu-west-1.amazonaws.com/prod/sauna-list`
 *   → 200 `application/json`, ei avainta, `access-control-allow-origin: *`.
 *   Palauttaa taulukon saunoja (~22 kpl, ~55 kt).
 *
 * Rajapinnalla ei ole dokumentoitua skeemaa, joten **kaikki normalisoidaan
 * puolustavasti**: tuntemattomat kenttätyypit eivät kaada vastausta, ja
 * epäkelvot tietueet pudotetaan (§20-henki: puuttuva tieto näkyy puuttuvana,
 * ei virheenä koko sivulle). Kenttä `info` on vapaata tekstiä ja `prices`
 * sijaitsevat aukiolojakson sisällä — siksi hinnat kulkevat jakson mukana.
 */

import type { Sauna, SaunaOpeningHours, SaunaPrice } from './types';

/** Rajapinnan osoite; ympäristömuuttujalla voi vaihtaa (esim. testiympäristö). */
export const SAUNA_LIST_URL =
  process.env['SAUNA_LIST_URL'] ??
  'https://08aapg0u7e.execute-api.eu-west-1.amazonaws.com/prod/sauna-list';

/** Lähteetön HTTP/parse-virhe tilakoodin kanssa (kutsuja päättää uusinnasta). */
export class SaunaUpstreamError extends Error {
  /** HTTP-tilakoodi, tai `0` jos virhe on vastauksen muodossa. */
  readonly status: number;
  readonly resource: string;

  constructor(status: number, resource: string, message?: string) {
    super(message ?? `Saunahaku vastasi ${status} (${resource})`);
    this.name = 'SaunaUpstreamError';
    this.status = status;
    this.resource = resource;
  }
}

/**
 * Hakee saunaluettelon ja palauttaa normalisoidut saunat.
 * Heittää `SaunaUpstreamError`in, jos vastaus ei ole 2xx tai muoto on väärä.
 */
export async function fetchSaunaList(timeoutMs: number): Promise<Sauna[]> {
  const response = await fetch(SAUNA_LIST_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new SaunaUpstreamError(response.status, 'sauna-list');
  }

  const raw: unknown = await response.json();
  return normalizeSaunaList(raw);
}

/** Merkkijonoksi vain jos arvo on merkkijono — muuten tyhjä (ei arvausta). */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

/** Numeerinen arvo numerona tai merkkijonona; muuten `null`. */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function normalizePrice(raw: unknown): SaunaPrice | null {
  const obj = asObject(raw);
  if (!obj) return null;
  const price = asNumber(obj['price']);
  const priceType = asString(obj['priceType']).trim();
  if (price === null || !priceType) return null;
  return { priceType, price };
}

function normalizeOpeningHours(raw: unknown): SaunaOpeningHours | null {
  const obj = asObject(raw);
  if (!obj) return null;
  const weekday = asString(obj['weekday']).trim().toUpperCase();
  const openingTime = asString(obj['openingTime']).trim();
  const closingTime = asString(obj['closingTime']).trim();
  if (!weekday || !openingTime || !closingTime) return null;

  const prices = asArray(obj['prices'])
    .map(normalizePrice)
    .filter((price): price is SaunaPrice => price !== null);

  return { weekday, openingTime, closingTime, prices };
}

/**
 * Normalisoi yhden saunan. Palauttaa `null`, jos tunniste tai nimi puuttuu —
 * ilman niitä tietuetta ei voi näyttää listalla.
 */
export function normalizeSauna(raw: unknown): Sauna | null {
  const obj = asObject(raw);
  if (!obj) return null;

  const id = asString(obj['id']).trim();
  const name = asString(obj['name']).trim();
  if (!id || !name) return null;

  const openingHours = asArray(obj['openingHours'])
    .map(normalizeOpeningHours)
    .filter((entry): entry is SaunaOpeningHours => entry !== null);

  return {
    id,
    name,
    streetAddress: asString(obj['streetAddress']).trim(),
    postalCode: asString(obj['postalCode']).trim(),
    city: asString(obj['city']).trim(),
    openingHours,
    phone: asString(obj['phone']).trim(),
    webPage: asString(obj['webPage']).trim(),
    info: asString(obj['info']).trim(),
    kiosk: asBoolean(obj['kiosk']),
    restaurant: asBoolean(obj['restaurant']),
    isNew: asBoolean(obj['isNew']),
  };
}

/**
 * Normalisoi koko listan. Heittää virheen, jos juurimuoto ei ole taulukko —
 * se on merkki siitä, että rajapinta on muuttunut eikä tyhjä vastaus ole
 * oikea tulkinta (§20: puuttuvaa ei arvata).
 */
export function normalizeSaunaList(raw: unknown): Sauna[] {
  if (!Array.isArray(raw)) {
    throw new SaunaUpstreamError(
      0,
      'sauna-list',
      'Saunalistan muoto oli odottamaton (ei taulukko)',
    );
  }

  return raw.map(normalizeSauna).filter((sauna): sauna is Sauna => sauna !== null);
}
