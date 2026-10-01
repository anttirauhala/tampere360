/**
 * water-temperature — Näsijärven pintaveden lämpötila (arkkitehtuuri §34).
 *
 * Reitti:
 *   `GET /v1/water/temperature`
 *
 * Putki: API Gateway HTTP API → tämä Lambda → (muistivälimuisti 5 min) → SYKE
 * Hydrologiarajapinta (OData) → JSON.
 *
 * **Miksi oma Lambda eikä `apps/api`:** lämpötila ei tule DynamoDB:stä eikä
 * kuluta lukukapasiteettia, ja **5 minuutin välimuisti** (vaatimus) pitää
 * upstream-kutsut kurissa. Oma varattu concurrency erottaa reitin
 * query-Lambdan (5) sekä muiden reittien kustannuskatosta.
 *
 * **Miksi ei selaimesta suoraan:** SYKE-rajapinta on ODataa (kyselyparametrit,
 * `$expand`), joten kyselyn rakentaminen ja normalisointi kuuluvat palvelimelle;
 * lisäksi CSP pysyy muuttumattomana, kun data tulee oman API:n kautta.
 */

import {
  createLogger,
  newCorrelationId,
  serializeError,
  withCorrelationId,
} from '@tampere360/observability';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import { type CachedValue, createKeyedCache } from './cache';
import { SYKE_HYDRO_BASE_URL, fetchSurfaceWaterTemperature } from './syke';
import type { WaterStationRef, WaterTemperatureReading, WaterTemperatureResponse } from './types';

const logger = createLogger({
  service: 'water-temperature',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});

/** Positiivinen luku ympäristömuuttujasta tai oletus. */
function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Valinnainen luku ympäristömuuttujasta tai `null` (esim. koordinaatit). */
function envOptionalNumber(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

const baseUrl = process.env['SYKE_HYDRO_URL'] ?? SYKE_HYDRO_BASE_URL;
const paikkaId = envNumber('WATER_PAIKKA_ID', 1694);
const upstreamTimeoutMs = envNumber('WATER_UPSTREAM_TIMEOUT_MS', 5_000);

/**
 * Varapaikan tiedot, jos lähde ei palauta havaintoja (`$expand` ei tuo Paikkaa).
 * Arvot tulevat konfiguraatiosta (infra/lib/config.ts), jotta vastaus on aina
 * saman muotoinen.
 */
const fallbackStation: WaterStationRef = {
  id: paikkaId,
  name: process.env['WATER_STATION_NAME'] ?? 'Näsijärvi, Kyrönlahti',
  lake: process.env['WATER_LAKE_NAME'] ?? 'Näsijärvi',
  municipality: process.env['WATER_MUNICIPALITY'] ?? 'Ylöjärvi',
  latitude: envOptionalNumber('WATER_STATION_LAT'),
  longitude: envOptionalNumber('WATER_STATION_LON'),
};

/**
 * Yksi välimuistiava. **5 min TTL** (vaatimus): havainto on päivittäinen, joten
 * tiuhempi haku ei toisi tuoreempaa tietoa mutta kertautuisi jokaisen avoimen
 * selaimen myötä.
 */
const cache = createKeyedCache<WaterTemperatureReading>({
  ttlMs: envNumber('WATER_CACHE_MS', 5 * 60_000),
  staleMaxMs: envNumber('WATER_STALE_MAX_MS', 7 * 86_400_000),
  maxEntries: 1,
  now: () => Date.now(),
});

function jsonResponse(
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
    body: JSON.stringify(body),
  };
}

async function loadReading(): Promise<WaterTemperatureReading> {
  const started = Date.now();
  const reading = await fetchSurfaceWaterTemperature(
    baseUrl,
    paikkaId,
    fallbackStation,
    upstreamTimeoutMs,
  );
  logger.info('Pintaveden lämpötila haettu', {
    station: reading.station.name,
    temperatureC: reading.temperatureC,
    measuredAt: reading.measuredAt,
    durationMs: Date.now() - started,
  });
  return reading;
}

/** `GET /v1/water/temperature`. */
async function handleTemperature(): Promise<APIGatewayProxyResultV2> {
  let entry: CachedValue<WaterTemperatureReading>;
  try {
    entry = await cache.get('latest', loadReading);
  } catch (error) {
    logger.error('Pintaveden lämpötilan haku epäonnistui', { error: serializeError(error) });
    return jsonResponse(503, { error: 'UPSTREAM_UNAVAILABLE' }, { 'retry-after': '300' });
  }

  const response: WaterTemperatureResponse = {
    ...entry.value,
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
    stale: entry.stale,
    source: {
      system: 'SYKE',
      name: 'SYKE Hydrologiarajapinta',
      url: baseUrl,
      license: 'CC BY 4.0',
    },
  };
  return jsonResponse(200, response, { 'cache-control': 'public, max-age=300' });
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return withCorrelationId(newCorrelationId(), async () => {
    const path = event.rawPath ?? '';
    if (path.endsWith('/v1/water/temperature')) return handleTemperature();
    return jsonResponse(404, { error: 'NOT_FOUND' });
  });
}
