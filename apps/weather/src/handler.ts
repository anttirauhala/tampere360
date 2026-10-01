/**
 * weather — Tampereen nykyinen sää (arkkitehtuuri §31).
 *
 * Reitti: `GET /v1/weather/current`
 *
 * Putki: API Gateway HTTP API → tämä Lambda → (muistivälimuisti) → FMI:n
 * avoin WFS (`fmi::observations::weather::timevaluepair`) → JSON.
 *
 * **Miksi oma Lambda eikä `apps/api`:** sää ei tule DynamoDB:stä eikä kuluta
 * lukukapasiteettia, ja FMI:n WFS:llä on pyyntörajat (10 000/vrk, 600 / 5 min)
 * — palvelimen välimuisti pitää upstream-kutsut kurissa (N selainta → 1 kutsu
 * / TTL / lämmin kontti). Oma varattu concurrency erottaa reitin query-Lambdan
 * (5) sekä ajoneuvo- (2), pysäkki- (2) ja mittausasema-Lambdan (3)
 * kustannuskatosta.
 *
 * **Miksi ei selaimesta suoraan:** FMI sallii CORSin, mutta vastaus on
 * WaterML 2.0 -XML:ää (~28 kt / parametri), joten jäsennys kuuluu palvelimelle
 * (selain saisi muuten XML-parserin bundleen ja uuden CSP-originin).
 */

import {
  createLogger,
  newCorrelationId,
  serializeError,
  withCorrelationId,
} from '@tampere360/observability';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import { type CachedValue, createKeyedCache } from './cache';
import { buildObservationUrl, FMI_WFS_URL, fetchObservationXml } from './fmi';
import { FMI_PARAMETERS, type ParsedWeather, parseTimeValuePairs } from './parse';
import type { CurrentWeatherResponse, WeatherStationRef } from './types';

const logger = createLogger({
  service: 'weather',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});

/** Positiivinen luku ympäristömuuttujasta tai oletus. */
function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Tampere-Pirkkala lentoasema: FMI:n täydellisin havaintoasema Tampereella. */
const fmisid = process.env['WEATHER_FMISID'] ?? '101118';
const stationName = process.env['WEATHER_STATION_NAME'] ?? 'Tampere-Pirkkala lentoasema';
const observationHours = envNumber('WEATHER_OBSERVATION_HOURS', 3);
const upstreamTimeoutMs = envNumber('WEATHER_UPSTREAM_TIMEOUT_MS', 6_000);

/**
 * Yksi välimuistiava: FMI päivittää havainnot noin 10 minuutin välein, joten
 * 5 min TTL ei hävitä tuoreutta mutta pitää upstream-kutsut harvassa.
 */
const cache = createKeyedCache<ParsedWeather>({
  ttlMs: envNumber('WEATHER_CACHE_MS', 300_000),
  staleMaxMs: envNumber('WEATHER_STALE_MAX_MS', 1_800_000),
  maxEntries: 1,
  now: () => Date.now(),
});

/** Hakee ja jäsentää havainnon FMI:ltä. */
async function load(): Promise<ParsedWeather> {
  const started = Date.now();
  const url = buildObservationUrl({ fmisid, parameters: FMI_PARAMETERS, hours: observationHours });
  const xml = await fetchObservationXml(url, upstreamTimeoutMs);
  const parsed = parseTimeValuePairs(xml);
  logger.info('Säähavainto haettu FMI:ltä', {
    fmisid,
    observedAt: parsed.observedAt,
    parameters: Object.keys(parsed.values),
    durationMs: Date.now() - started,
  });
  return parsed;
}

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

/** Kokoaa API-vastauksen: puuttuva arvo pysyy `null`ina (§20). */
export function buildResponse(
  parsed: ParsedWeather,
  fetchedAtMs: number,
  stale: boolean,
): CurrentWeatherResponse {
  const station: WeatherStationRef = {
    fmisid: parsed.station.fmisid ?? fmisid,
    name: parsed.station.name ?? stationName,
    latitude: parsed.station.latitude,
    longitude: parsed.station.longitude,
  };

  return {
    station,
    observedAt: parsed.observedAt,
    temperatureC: parsed.values.temperature ?? null,
    humidityPct: parsed.values.humidity ?? null,
    windSpeedMs: parsed.values.windspeedms ?? null,
    windGustMs: parsed.values.windgust ?? null,
    windDirectionDeg: parsed.values.winddirection ?? null,
    pressureHpa: parsed.values.pressure ?? null,
    precipitation1hMm: parsed.values.precipitation1h ?? null,
    cloudCoverOktas: parsed.values.n_man ?? null,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    stale,
    source: { system: 'FMI_OBSERVATION', url: FMI_WFS_URL, license: 'CC BY 4.0' },
  };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return withCorrelationId(newCorrelationId(), async () => {
    const path = event.rawPath ?? '';
    if (!path.endsWith('/v1/weather/current')) return jsonResponse(404, { error: 'NOT_FOUND' });

    let entry: CachedValue<ParsedWeather>;
    try {
      entry = await cache.get('current', load);
    } catch (error) {
      logger.error('Säähavainnon haku epäonnistui', { error: serializeError(error) });
      // 503 eikä 502: kyse on lähteen tilapäisestä viasta, ja selain saa luvan
      // yrittää uudelleen. Frontend näyttää tämän rauhallisena huomautuksena.
      return jsonResponse(503, { error: 'UPSTREAM_UNAVAILABLE' }, { 'retry-after': '30' });
    }

    // Selain saa välimuistittaa lyhyesti: sama data palvellaan joka tapauksessa
    // välimuistista koko TTL-ajan.
    return jsonResponse(200, buildResponse(entry.value, entry.fetchedAt, entry.stale), {
      'cache-control': 'public, max-age=60',
    });
  });
}
