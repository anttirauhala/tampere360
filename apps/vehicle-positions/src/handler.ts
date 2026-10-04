/**
 * vehicle-positions — joukkoliikenteen ajoneuvosijainnit kartalle (§27).
 *
 * Reitti: `GET /v1/vehicles?mode=TRAM|BUS`
 *
 * Putki: API Gateway HTTP API → tämä Lambda → (muistivälimuisti) → Waltti SIRI
 * VehicleMonitoring → GeoJSON.
 *
 * **Miksi oma Lambda eikä `apps/api`:**
 *  - ajoneuvot eivät tule DynamoDB:stä eivätkä kuluta lukukapasiteettia
 *  - pollaus on 5 s, kun tilanteita pollataan 30–60 s välein → oma varattu
 *    concurrency pitää huolen, ettei karttasivun liikenne syö query-Lambdan
 *    kustannuskattoa (ks. infra/lib/config.ts)
 *  - Waltti-avain pysyy palvelimella (sama SSM-parametri kuin Nysse-adapterilla)
 *
 * **Miksi SIRI eikä GTFS-RT:** ks. `siri.ts`.
 */

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  createLogger,
  newCorrelationId,
  serializeError,
  withCorrelationId,
} from '@tampere360/observability';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import { createSnapshotCache } from './cache';
import { buildVehicleFeatureCollection, filterVehicleFeatures } from './geojson';
import { parseMode } from './params';
import { parseSiriFeed } from './siri';
import type { VehicleFeatureCollection } from './types';

const logger = createLogger({
  service: 'vehicle-positions',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});
const ssm = new SSMClient({});

/** Walttin dokumentoitu SIRI-päätepiste (POST, Basic-auth). */
const SIRI_URL = 'https://data.waltti.fi/tampere/api/sirirealtime/v1.3/ws';

/**
 * Waltti-dokumentaation mukainen pyyntö: kaikki ajoneuvot. Pyyntö on vakio,
 * joten se pidetään yhtenä merkkijonona (sama muoto on verifioitu käsin
 * 26.9.2026 — `RequestorRef`ia ei tarvita).
 */
const SIRI_REQUEST_BODY =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Siri xmlns="http://www.siri.org.uk/siri" version="1.3"><ServiceRequest>' +
  '<VehicleMonitoringRequest version="1.3"><VehicleMonitoringRef>VEHICLES_ALL</VehicleMonitoringRef>' +
  '</VehicleMonitoringRequest></ServiceRequest></Siri>';

/** API-avain ei vaihdu kesken kontin elinkaaren → pidetään se muistissa. */
const API_KEY_TTL_MS = 10 * 60_000;

/** Positiivinen luku ympäristömuuttujasta tai oletus. */
function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const cacheTtlMs = envNumber('VEHICLE_CACHE_MS', 5_000);
const staleMaxMs = envNumber('VEHICLE_STALE_MAX_MS', 60_000);
const maxAgeMs = envNumber('VEHICLE_MAX_AGE_MINUTES', 5) * 60_000;
const upstreamTimeoutMs = envNumber('VEHICLE_UPSTREAM_TIMEOUT_MS', 4_000);
const apiKeyPath = process.env['SSM_API_KEY_PATH'] ?? '';

let cachedApiKey: { value: string; fetchedAt: number } | null = null;

/** Hakee Waltti-avaimen SSM:stä (sama parametri kuin ingest-nysse käyttää). */
async function getApiKey(): Promise<string> {
  const now = Date.now();
  if (cachedApiKey && now - cachedApiKey.fetchedAt < API_KEY_TTL_MS) return cachedApiKey.value;

  const result = await ssm.send(
    new GetParameterCommand({ Name: apiKeyPath, WithDecryption: true }),
  );
  const value = result.Parameter?.Value ?? '';
  if (!value) throw new Error(`Nysse API-avain puuttuu SSM:stä (${apiKeyPath})`);

  cachedApiKey = { value, fetchedAt: now };
  return value;
}

/** Hakee SIRI VehicleMonitoring -vastauksen XML:nä. */
async function fetchSiriVehicles(): Promise<string> {
  const apiKey = await getApiKey();
  const response = await fetch(SIRI_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${apiKey}`,
      'content-type': 'application/xml',
      accept: 'application/xml',
    },
    body: SIRI_REQUEST_BODY,
    signal: AbortSignal.timeout(upstreamTimeoutMs),
  });
  if (!response.ok) throw new Error(`Waltti SIRI vastasi ${response.status}`);
  return response.text();
}

/**
 * Snapshot sisältää **kaikki** ajoneuvot molemmista muodoista; `mode`-suodatus
 * tehdään pyyntökohtaisesti (halpa operaatio 177 riville).
 */
const cache = createSnapshotCache<VehicleFeatureCollection>({
  ttlMs: cacheTtlMs,
  staleMaxMs,
  now: () => Date.now(),
  load: async () => {
    const started = Date.now();
    const xml = await fetchSiriVehicles();
    const feed = parseSiriFeed(xml);
    const collection = buildVehicleFeatureCollection(feed.vehicles, {
      generatedAt: feed.generatedAt,
      fetchedAt: new Date().toISOString(),
      now: Date.now(),
      maxAgeMs,
    });
    logger.info('Ajoneuvot haettu Walttilta', {
      vehicles: collection.features.length,
      counts: collection.counts,
      xmlBytes: xml.length,
      durationMs: Date.now() - started,
    });
    return collection;
  },
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

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return withCorrelationId(newCorrelationId(), async () => {
    const path = event.rawPath ?? '';
    if (!path.endsWith('/v1/vehicles')) return jsonResponse(404, { error: 'NOT_FOUND' });

    const mode = parseMode((event.queryStringParameters ?? {})['mode']);
    if (mode === null)
      return jsonResponse(400, { error: 'INVALID_MODE', allowed: ['TRAM', 'BUS'] });

    try {
      const { value, stale } = await cache.get();
      const filtered = filterVehicleFeatures(value, mode);
      // Selain saa välimuistittaa vastauksen lyhyesti: sama data palvellaan
      // joka tapauksessa välimuistista koko TTL-ajan.
      return jsonResponse(200, { ...filtered, stale }, { 'cache-control': 'public, max-age=5' });
    } catch (error) {
      logger.error('Ajoneuvotietojen haku epäonnistui', { error: serializeError(error) });
      return jsonResponse(502, { error: 'UPSTREAM_UNAVAILABLE' });
    }
  });
}
