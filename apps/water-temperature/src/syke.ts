/**
 * SYKE Hydrologiarajapinta (OData 3.0) — pintaveden lämpötila (§34).
 *
 * Lähde (verifioitu 1.10.2026):
 *   `https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.2/odata`
 *   → OData 3.0; `LampoPintavesi` = "Pintaveden lämpötila" (T, °C)
 *   → CC BY 4.0 (Suomen ympäristökeskus), ei API-avainta.
 *
 * **Miksi `Accept: application/json` eikä `$format=json`:** rajapinta hylkää
 * `$format`-kyselyparametrin ("Query option 'Format' is not allowed"); muoto
 * valitaan otsikolla.
 *
 * **Miksi `$expand=Paikka`:** yhdellä kutsulla saadaan sekä uusin arvo että
 * paikan nimi ja kunta, joten erillistä `Paikka`-kutsua ei tarvita. Jos
 * havaintoja ei ole, paikkatiedot otetaan kutsujan antamasta varavakiosta
 * (konfiguraatio), jotta vastaus on aina sama muodoltaan.
 */

import type { WaterStationRef, WaterTemperatureReading } from './types';

/** Rajapinnan juuri (OData); ympäristömuuttujalla voi vaihtaa. */
export const SYKE_HYDRO_BASE_URL =
  process.env['SYKE_HYDRO_URL'] ??
  'https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.2/odata';

/** Lähteetön HTTP-virhe tilakoodin kanssa. */
export class SykeError extends Error {
  readonly status: number;
  readonly resource: string;

  constructor(status: number, resource: string, message?: string) {
    super(message ?? `SYKE vastasi ${status} (${resource})`);
    this.name = 'SykeError';
    this.status = status;
    this.resource = resource;
  }
}

/**
 * URL uusimmalle pintaveden lämpötilahavainnolle: uusin ensin, yksi rivi,
 * paikkatiedot mukaan (`$expand=Paikka`).
 */
export function buildLatestTemperatureUrl(baseUrl: string, paikkaId: number): string {
  const filter = encodeURIComponent(`Paikka_Id eq ${paikkaId}`);
  return `${baseUrl}/LampoPintavesi?$filter=${filter}&$orderby=Aika%20desc&$top=1&$expand=Paikka`;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * SYKE antaa koordinaatit muodossa **DDMMSS** (esim. `614242` = 61°42′42″).
 * Palauttaa desimaaliasteet tai `null`, jos muoto ei täsmää (§20: ei arvausta).
 */
export function parseDdmmss(value: unknown): number | null {
  const raw = String(value ?? '').trim();
  const match = /^(\d{2})(\d{2})(\d{2})/.exec(raw);
  if (!match) return null;
  const deg = Number(match[1]);
  const min = Number(match[2]);
  const sec = Number(match[3]);
  if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec)) return null;
  return deg + min / 60 + sec / 3600;
}

function toStation(raw: unknown, fallback: WaterStationRef): WaterStationRef {
  if (raw === null || typeof raw !== 'object') return fallback;
  const obj = raw as Record<string, unknown>;
  return {
    id: toNumber(obj['Paikka_Id']) ?? fallback.id,
    name: toString(obj['Nimi']) || fallback.name,
    lake: toString(obj['JarviNimi']) || fallback.lake,
    municipality: toString(obj['KuntaNimi']) || fallback.municipality,
    latitude: parseDdmmss(obj['KoordLat']) ?? fallback.latitude,
    longitude: parseDdmmss(obj['KoordLong']) ?? fallback.longitude,
  };
}

/**
 * Poimii uusimman havainnon OData-vastauksesta. Puuttuva arvo on `null`, ei
 * nolla. Tyhjä vastaus (ei havaintoja) palauttaa varapaikan `null`-arvolla.
 */
export function parseLatestTemperature(
  raw: unknown,
  fallback: WaterStationRef,
): WaterTemperatureReading {
  const root = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rows = Array.isArray(root['value']) ? (root['value'] as unknown[]) : [];
  const row = rows[0];
  if (row === null || row === undefined || typeof row !== 'object') {
    return { temperatureC: null, measuredAt: null, station: fallback };
  }
  const obj = row as Record<string, unknown>;
  return {
    temperatureC: toNumber(obj['Arvo']),
    measuredAt: typeof obj['Aika'] === 'string' ? obj['Aika'] : null,
    station: toStation(obj['Paikka'], fallback),
  };
}

/** Hakee uusimman pintaveden lämpötilan ja paikkatiedot. */
export async function fetchSurfaceWaterTemperature(
  baseUrl: string,
  paikkaId: number,
  fallback: WaterStationRef,
  timeoutMs: number,
): Promise<WaterTemperatureReading> {
  const response = await fetch(buildLatestTemperatureUrl(baseUrl, paikkaId), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new SykeError(response.status, 'LampoPintavesi');

  const raw: unknown = await response.json();
  return parseLatestTemperature(raw, fallback);
}
