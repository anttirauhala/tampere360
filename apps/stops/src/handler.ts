/**
 * stops — Nysse-pysäkit ja reaaliaikaiset lähdöt (arkkitehtuuri §28).
 *
 * Reitit:
 *   `GET /v1/stops`                       staattinen pysäkkirekisteri (GeoJSON)
 *   `GET /v1/stops/{stopId}/departures`   reaaliaikaiset lähdöt (SIRI SM)
 *
 * **Miksi oma Lambda eikä `apps/api`:** pysäkit ja lähdöt eivät tule
 * DynamoDB:stä eivätkä kuluta lukukapasiteettia, ja pysäkkimonitori pollaa
 * 15 sekunnin välein. Oma varattu concurrency erottaa reitin query-Lambdan
 * kustannuskatosta (ks. infra/lib/config.ts).
 *
 * **Miksi lähdöt eivät kulje ajoneuvolambdan kautta:** ajoneuvot (VehicleMonitoring)
 * ja pysäkkilähdöt (StopMonitoring) ovat eri SIRI-palveluja eri
 * päivitysväleillä ja eri välimuisteilla — sekoittaminen tekisi molemmista
 * vaikeampia ymmärtää ja mitoittaa (§28 kohta 5).
 */

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  createLogger,
  newCorrelationId,
  serializeError,
  withCorrelationId,
} from '@tampere360/observability';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import { type CachedValue, createKeyedCache } from './cache';
import { createStopCoverageTracker } from './coverage';
import { buildStopDepartures } from './departures';
import { parseStopsCsv, readStopsFromZip } from './gtfs';
import { parseStopId } from './params';
import { isRetryableUpstreamError, withRetry } from './retry';
import {
  SIRI_URL,
  SiriUpstreamError,
  buildStopMonitoringRequest,
  parseStopMonitoringFeed,
} from './siri-sm';
import { buildStopFeatureCollection, findStop, stopFromName } from './stop-points';
import type { GtfsStop, StopDeparture, StopDeparturesResponse } from './types';

const logger = createLogger({
  service: 'stops',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});
const ssm = new SSMClient({});

/** Nyssen/Tampereen GTFS-static-paketti (ITS Factory, CC BY 4.0). */
const GTFS_URL =
  process.env['GTFS_STOPS_URL'] ??
  'https://data.itsfactory.fi/journeys/files/gtfs/latest/gtfs_tampere.zip';

/** API-avain ei vaihdu kesken kontin elinkaaren → pidetään se muistissa. */
const API_KEY_TTL_MS = 10 * 60_000;

const apiKeyPath = process.env['SSM_API_KEY_PATH'] ?? '';
const gtfsTimeoutMs = envNumber('GTFS_STOPS_TIMEOUT_MS', 15_000);
const siriTimeoutMs = envNumber('STOP_UPSTREAM_TIMEOUT_MS', 5_000);
const previewMinutes = envNumber('STOP_PREVIEW_MINUTES', 60);
const departureLimit = envNumber('STOP_DEPARTURE_LIMIT', 20);
/** Waltti antaa ajoittain tilapäisiä 500-virheitä → yksi uusintayritys. */
const retryAttempts = envNumber('STOP_RETRY_ATTEMPTS', 2);
const retryBackoffMs = envNumber('STOP_RETRY_BACKOFF_MS', 250);

let cachedApiKey: { value: string; fetchedAt: number } | null = null;

/** Positiivinen luku ympäristömuuttujasta tai oletus. */
function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Staattinen pysäkkirekisteri: TTL tunteja, koska aineisto päivittyy harvoin.
 * Yksi avain (`maxEntries: 1`) — koko rekisteri on yksi arvo.
 */
const staticCache = createKeyedCache<GtfsStop[]>({
  ttlMs: envNumber('GTFS_STOPS_CACHE_MS', 6 * 3_600_000),
  staleMaxMs: envNumber('GTFS_STOPS_STALE_MAX_MS', 7 * 86_400_000),
  maxEntries: 1,
  now: () => Date.now(),
});

/**
 * Reaaliaikaiset lähdöt: TTL 15 s (§28 kohta 6). SIRI päivittyy itse 30 sekunnin
 * välein, joten 15 s on tuoreuden yläraja eikä aiheuta turhia upstream-kutsuja.
 */
const departureCache = createKeyedCache<DeparturesPayload>({
  ttlMs: envNumber('STOP_CACHE_MS', 15_000),
  staleMaxMs: envNumber('STOP_STALE_MAX_MS', 60_000),
  maxEntries: envNumber('STOP_CACHE_MAX_ENTRIES', 200),
  now: () => Date.now(),
});

interface DeparturesPayload {
  departures: StopDeparture[];
  /** Lähteen tuotantoaika (UTC-ISO) tai null. */
  generatedAt: string | null;
  /** Pysäkin nimi lähteen vastauksesta (`StopVisitNote`) — varanimi ilman GTFS:ää. */
  stopName: string | null;
}

const coverageFailureThreshold = envNumber('STOP_COVERAGE_FAILURE_THRESHOLD', 3);

/**
 * Pysäkin reaaliaikapeitto: opitaan toistuvista virheistä (ks. `coverage.ts`).
 * Onnistunut haku pyyhkii laskurin, joten tilapäinen lähdevirhe ei merkitse
 * pysäkkiä ilman peittoa.
 */
const coverage = createStopCoverageTracker({
  failureThreshold: coverageFailureThreshold,
  failureWindowMs: envNumber('STOP_COVERAGE_WINDOW_MS', 120_000),
  uncoveredTtlMs: envNumber('STOP_COVERAGE_TTL_MS', 30 * 60_000),
  maxEntries: envNumber('STOP_COVERAGE_MAX_ENTRIES', 500),
  now: () => Date.now(),
});

/** Hakee Waltti-avaimen SSM:stä (sama parametri kuin ajoneuvo- ja Nysse-adapteri). */
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

/** Yksi yritys hakea StopMonitoring-vastaus XML:nä. */
async function attemptSiriStopMonitoring(stopId: string): Promise<string> {
  const apiKey = await getApiKey();
  const response = await fetch(SIRI_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${apiKey}`,
      'content-type': 'application/xml',
      accept: 'application/xml',
    },
    body: buildStopMonitoringRequest([stopId], previewMinutes),
    signal: AbortSignal.timeout(siriTimeoutMs),
  });
  if (!response.ok) {
    // Runko luetaan diagnostiikkaa varten (Waltti vastaa 500:lla "Something went
    // wrong"), ja statuskoodi kulkee virheolion mukana uusintapäätöstä varten.
    const body = await response.text().catch(() => '');
    throw new SiriUpstreamError(response.status, body);
  }
  return response.text();
}

/**
 * Hakee StopMonitoring-vastauksen XML:nä yhdelle pysäkille.
 *
 * Waltti vastaa ajoittain tilapäisellä 500:lla — yksi uusintayritys (250 ms)
 * poistaa ne tapaukset, jotka eivät ole pysäkkikohtaisia (ks. `retry.ts`).
 */
async function fetchSiriStopMonitoring(stopId: string): Promise<string> {
  return withRetry(() => attemptSiriStopMonitoring(stopId), {
    attempts: retryAttempts,
    backoffMs: retryBackoffMs,
    isRetryable: isRetryableUpstreamError,
    onRetry: (error, attempt) => {
      logger.warn('Waltti SIRI SM uudelleenyritys', {
        stopId,
        attempt,
        error: serializeError(error),
      });
    },
  });
}

/** Lataa ja jäsentää GTFS-static-aineiston pysäkit. */
async function loadGtfsStops(): Promise<GtfsStop[]> {
  const started = Date.now();
  const response = await fetch(GTFS_URL, { signal: AbortSignal.timeout(gtfsTimeoutMs) });
  if (!response.ok) throw new Error(`GTFS-haku epäonnistui: ${response.status}`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  const stops = parseStopsCsv(readStopsFromZip(bytes));
  // Tyhjä tulos ei ole "ei pysäkkejä" vaan merkki lähdemuutoksesta: silloin
  // välimuistiin ei pidä jäädä tyhjää arvoa, vaan virhe on nostettava.
  if (stops.length === 0) throw new Error('GTFS-aineistosta ei löytynyt yhtään pysäkkiä');

  logger.info('GTFS-pysäkit haettu', {
    stops: stops.length,
    bytes: bytes.byteLength,
    durationMs: Date.now() - started,
  });
  return stops;
}

/** Hakee ja rakentaa yhden pysäkin lähtölistan. */
async function loadDepartures(stopId: string): Promise<DeparturesPayload> {
  const started = Date.now();
  const xml = await fetchSiriStopMonitoring(stopId);
  const feed = parseStopMonitoringFeed(xml);

  const matching = feed.visits.filter((visit) => visit.stopId === stopId);
  // Jos lähde kaikuu tunnisteen eri muodossa (esim. ilman etunollia), käytetään
  // kaikkia vuoroja: yhden pysäkin pyynnössä ne ovat kaikki tälle pysäkille.
  const visits = matching.length > 0 ? matching : feed.visits;

  const departures = buildStopDepartures(visits, { now: Date.now(), limit: departureLimit });
  const stopName = visits.find((visit) => visit.stopName)?.stopName ?? null;

  logger.info('Pysäkin lähdöt haettu', {
    stopId,
    visits: visits.length,
    departures: departures.length,
    xmlBytes: xml.length,
    durationMs: Date.now() - started,
  });

  return { departures, generatedAt: feed.generatedAt, stopName };
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

/** `GET /v1/stops` — koko pysäkkirekisteri kartalle. */
async function handleStops(): Promise<APIGatewayProxyResultV2> {
  try {
    const entry: CachedValue<GtfsStop[]> = await staticCache.get('gtfs', loadGtfsStops);
    const collection = buildStopFeatureCollection(entry.value, {
      fetchedAt: new Date(entry.fetchedAt).toISOString(),
      stale: entry.stale,
    });
    // Selain saa pitää vastauksen: rekisteri muuttuu käytännössä päivittäin,
    // eikä välilehden vaihto saa aiheuttaa uutta 17 Mt:n upstream-latausta.
    return jsonResponse(200, collection, { 'cache-control': 'public, max-age=1800' });
  } catch (error) {
    logger.error('Pysäkkirekisterin haku epäonnistui', { error: serializeError(error) });
    return jsonResponse(502, { error: 'UPSTREAM_UNAVAILABLE' });
  }
}

/**
 * Vastaus pysäkille, jolle Waltti ei palauta aikatauluja lainkaan.
 *
 * Tämä on **tieto eikä virhe**: pysäkki on olemassa (se on GTFS-rekisterissä ja
 * kartalla), mutta sen reaaliaikaisia lähtöjä ei ole saatavilla. Siksi HTTP 200
 * ja `realtimeCoverage: false` — frontend näyttää rauhallisen huomautuksen
 * virheilmoituksen sijaan ja lopettaa turhat uusintayritykset.
 */
function noCoverageResponse(stopId: string): APIGatewayProxyResultV2 {
  const stop = findStop(staticCache.peek('gtfs'), stopId) ?? stopFromName(stopId, null);
  const response: StopDeparturesResponse = {
    stop,
    departures: [],
    generatedAt: null,
    fetchedAt: new Date().toISOString(),
    stale: false,
    realtimeCoverage: false,
  };
  // Sama vastaus voidaan tarjoilla hetki: merkintä on voimassa 30 min.
  return jsonResponse(200, response, { 'cache-control': 'public, max-age=60' });
}

/** `GET /v1/stops/{stopId}/departures` — yhden pysäkin reaaliaikaiset lähdöt. */
async function handleDepartures(rawStopId: string): Promise<APIGatewayProxyResultV2> {
  const stopId = parseStopId(rawStopId);
  // Virheellinen tunniste ei ole "tyhjä pysäkki" vaan virhe: tunniste upotetaan
  // SIRI-pyyntöön, joten se on validoitava ennen kuin mitään lähetetään.
  if (!stopId) return jsonResponse(400, { error: 'INVALID_STOP_ID' });

  // Aiemmin opittu: Waltti ei tunne tätä pysäkkiä → ei turhaa upstream-kutsua.
  if (coverage.isUncovered(stopId)) {
    logger.info('Pysäkillä ei ole reaaliaikapeittoa — upstream-kutsu ohitetaan', { stopId });
    return noCoverageResponse(stopId);
  }

  try {
    const entry = await departureCache.get(stopId, () => loadDepartures(stopId));
    // Välimuisti voi palauttaa vanhentuneen arvon myös silloin, kun upstream-haku
    // epäonnistui (`stale: true`) — silloinkin haku on teknisesti epäonnistunut,
    // joten peittolaskurin pitää nähdä se.
    if (entry.stale) {
      logCoverageFailure(stopId, 'Välimuistin varavastaus');
      return departuresResponse(stopId, entry);
    }

    coverage.recordSuccess(stopId);
    // Nimi ja koordinaatit staattisesta rekisteristä **vain jos se on jo
    // muistissa**: pelkän nimen takia ei ladata 17 Mt:n GTFS-pakettia. Nimi
    // saadaan tarvittaessa SIRI-vastauksen `StopVisitNote`-kentästä.
    return departuresResponse(stopId, entry);
  } catch (error) {
    logger.error('Pysäkin lähtötietojen haku epäonnistui', {
      stopId,
      error: serializeError(error),
    });
    const marked = coverage.recordFailure(stopId);
    // Kolmas peräkkäinen virhe (ja muut pysäkit vastaavat) → pysäkki ei ole
    // Walttin reaaliaikarekisterissä. Kerrotaan se tiedona eikä virheenä.
    if (marked) {
      logger.warn('Pysäkki merkitty ilman reaaliaikapeittoa', {
        stopId,
        threshold: coverageFailureThreshold,
      });
      return noCoverageResponse(stopId);
    }
    // 503 eikä 502: kyse on lähteen tilapäisestä viasta, ja selain saa luvan
    // yrittää uudelleen (Retry-After). Frontend näyttää tämän rauhallisena
    // huomautuksena, ei teknisenä virhekoodina.
    return jsonResponse(503, { error: 'UPSTREAM_UNAVAILABLE', stopId }, { 'retry-after': '15' });
  }
}

/** Kirjaa peittolaskuriin epäonnistumisen ja mahdollisen merkinnän. */
function logCoverageFailure(stopId: string, reason: string): void {
  const marked = coverage.recordFailure(stopId);
  logger.warn('Lähtötietojen päivitys epäonnistui', { stopId, reason, marked });
}

/** Rakentaa onnistuneen lähtövastauksen. */
function departuresResponse(
  stopId: string,
  entry: CachedValue<DeparturesPayload>,
): APIGatewayProxyResultV2 {
  const stop =
    findStop(staticCache.peek('gtfs'), stopId) ?? stopFromName(stopId, entry.value.stopName);

  const response: StopDeparturesResponse = {
    stop,
    departures: entry.value.departures,
    generatedAt: entry.value.generatedAt,
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
    stale: entry.stale,
    realtimeCoverage: true,
  };
  return jsonResponse(200, response, { 'cache-control': 'public, max-age=15' });
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return withCorrelationId(newCorrelationId(), async () => {
    const path = event.rawPath ?? '';
    if (path.endsWith('/v1/stops')) return handleStops();

    const match = /^\/v1\/stops\/([^/]+)\/departures$/.exec(path);
    const rawStopId = match?.[1];
    if (rawStopId) return handleDepartures(rawStopId);

    return jsonResponse(404, { error: 'NOT_FOUND' });
  });
}
