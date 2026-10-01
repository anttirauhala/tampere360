/**
 * tms-stations — liikenteen mittausasemat (arkkitehtuuri §30).
 *
 * Reitit:
 *   `GET /v1/tms/stations`                            reaaliaikanäkymä (19 asemaa)
 *   `GET /v1/tms/stations/{tmsNumber}/history`        historia (?type=daily|hourly|speed)
 *
 * **Miksi oma Lambda eikä `apps/api`:** data ei tule DynamoDB:stä eikä kuluta
 * lukukapasiteettia, ja reaaliaikasnapshot päivittyy minuutin välein. Oma
 * varattu concurrency erottaa reitin query-Lambdan (5) sekä ajoneuvo- (2) ja
 * pysäkkilambdan (2) kustannuskatosta (ks. infra/lib/config.ts TMS_*).
 *
 * **Miksi selain ei hae suoraan Digitrafficilta:** kaikkien asemien
 * reaaliaikavastaus on 3,4 Mt pakkaamattomana (144 kt gzipattuna), ja
 * historia-rajapinta palauttaa CSV:tä ilman JSON-muotoa. Haku, suodatus
 * Tampereen seudulle ja CSV:n jäsennys kuuluvat palvelimelle; lisäksi
 * välimuisti pitää upstream-kutsut kurissa (N selainta → 1 kutsu per TTL).
 */

import {
  createLogger,
  newCorrelationId,
  serializeError,
  withCorrelationId,
} from '@tampere360/observability';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import { type CachedValue, createKeyedCache } from './cache';
import {
  DigitrafficError,
  fetchAllStationData,
  fetchHistoryCsv,
  fetchStationDetail,
  fetchStations,
} from './digitraffic';
import { parseDailySeries, parseHourlySeries, parseSpeedByDirection } from './history';
import { type StationMeta, buildStationMeta, selectRegionStations } from './metadata';
import { type HistoryType, parseTmsNumber, resolveHistoryQuery } from './params';
import { isRetryableUpstreamError, withRetry } from './retry';
import { buildStationsResponse } from './snapshot';
import type {
  DailyHistoryResponse,
  DigitrafficStationData,
  HistoryBase,
  HistoryPayload,
  HourlyHistoryResponse,
  SpeedHistoryResponse,
  StationsResponse,
} from './types';

const logger = createLogger({
  service: 'tms-stations',
  environment: process.env['ENVIRONMENT'] ?? 'dev',
});

/** Positiivinen luku ympäristömuuttujasta tai oletus. */
function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const metadataTimeoutMs = envNumber('TMS_UPSTREAM_TIMEOUT_MS', 5_000);
const historyTimeoutMs = envNumber('TMS_HISTORY_TIMEOUT_MS', 8_000);
const historyDays = envNumber('TMS_HISTORY_DAYS', 14);
/** Lähde on latenssiltaan epävakaa → yksi uusintayritys (ks. retry.ts). */
const historyRetryAttempts = envNumber('TMS_HISTORY_RETRY_ATTEMPTS', 2);
const historyRetryBackoffMs = envNumber('TMS_HISTORY_RETRY_BACKOFF_MS', 400);

/** Asemien metatiedot: 24 h välimuisti (nimet ja vapaan ajon nopeudet). */
const metadataCache = createKeyedCache<StationMeta[]>({
  ttlMs: envNumber('TMS_METADATA_CACHE_MS', 24 * 3_600_000),
  staleMaxMs: envNumber('TMS_METADATA_STALE_MAX_MS', 7 * 86_400_000),
  maxEntries: 1,
  now: () => Date.now(),
});

/** Reaaliaikainen snapshot: lähde päivittyy ~1 min välein. */
interface LiveSnapshot {
  generatedAt: string | null;
  byId: Map<number, DigitrafficStationData>;
}

const liveCache = createKeyedCache<LiveSnapshot>({
  ttlMs: envNumber('TMS_STATIONS_CACHE_MS', 60_000),
  staleMaxMs: envNumber('TMS_STATIONS_STALE_MAX_MS', 5 * 60_000),
  maxEntries: 1,
  now: () => Date.now(),
});

/** Historia: tilastot päivittyvät tunneittain ja koskevat päättyneitä jaksoja. */
const historyCache = createKeyedCache<HistoryPayload>({
  ttlMs: envNumber('TMS_HISTORY_CACHE_MS', 6 * 3_600_000),
  staleMaxMs: envNumber('TMS_HISTORY_STALE_MAX_MS', 7 * 86_400_000),
  maxEntries: envNumber('TMS_HISTORY_CACHE_MAX_ENTRIES', 200),
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

/**
 * Kokoaa asemien metatiedot: ensin simplified-lista (mistä tiedetään, mitkä
 * asemat osuvat Tampereen seudulle), sitten rinnakkain detailed-haut niille
 * asemille. Yksittäisen detailed-haun epäonnistuminen ei kaada koko vastausta —
 * asema jää listalle ilman vapaan ajon nopeutta (sujuvuus = `TUNTEMATON`).
 */
async function loadStations(): Promise<StationMeta[]> {
  const started = Date.now();
  const list = await fetchStations(metadataTimeoutMs);
  const selected = selectRegionStations(list);

  const details = await Promise.all(
    selected.map(async (feature) => {
      try {
        return await fetchStationDetail(feature.properties.id, metadataTimeoutMs);
      } catch (error) {
        logger.warn('Aseman metatietojen haku epäonnistui', {
          stationId: feature.properties.id,
          error: serializeError(error),
        });
        return null;
      }
    }),
  );

  const metas = selected.map((feature, index) => buildStationMeta(feature, details[index] ?? null));
  logger.info('Mittausasemien metatiedot koottu', {
    stations: metas.length,
    candidates: list.features?.length ?? 0,
    durationMs: Date.now() - started,
  });
  return metas;
}

/** Hakee kaikkien asemien reaaliaikaiset anturiarvot yhdellä kutsulla. */
async function loadLive(): Promise<LiveSnapshot> {
  const started = Date.now();
  const { dataUpdatedTime, byId } = await fetchAllStationData(metadataTimeoutMs);
  logger.info('Mittausasemien reaaliaikadata haettu', {
    stations: byId.size,
    generatedAt: dataUpdatedTime,
    durationMs: Date.now() - started,
  });
  return { generatedAt: dataUpdatedTime, byId };
}

/** Historia-rajapinnan yhteiset parametrit: `piste` on aseman `tmsNumber`. */
function historyQuery(tmsNumber: number, type: string, from: string, to: string) {
  return {
    tyyppi: type,
    pvm: from,
    loppu: to,
    lam_type: 'option1',
    piste: String(tmsNumber),
  };
}

/** Aseman tekninen nimi metatiedoista, jos ne ovat jo muistissa. */
function knownStationName(tmsNumber: number): string | null {
  const metas = metadataCache.peek('stations') ?? [];
  return metas.find((meta) => meta.tmsNumber === tmsNumber)?.name ?? null;
}

/** Reaaliaikanäkymä: `GET /v1/tms/stations`. */
async function handleStations(): Promise<APIGatewayProxyResultV2> {
  let metas: StationMeta[];
  let live: CachedValue<LiveSnapshot>;

  try {
    const metaEntry = await metadataCache.get('stations', loadStations);
    metas = metaEntry.value;
    live = await liveCache.get('live', loadLive);
  } catch (error) {
    logger.error('Mittausasemien haku epäonnistui', { error: serializeError(error) });
    // 503 eikä 502: kyse on lähteen tilapäisestä viasta, ja selain saa luvan
    // yrittää uudelleen. Frontend näyttää tämän rauhallisena huomautuksena.
    return jsonResponse(503, { error: 'UPSTREAM_UNAVAILABLE' }, { 'retry-after': '30' });
  }

  const now = Date.now();
  const response: StationsResponse = buildStationsResponse({
    metas,
    liveById: live.value.byId,
    generatedAt: live.value.generatedAt,
    fetchedAt: new Date(live.fetchedAt).toISOString(),
    nowMs: now,
    stale: live.stale,
  });

  return jsonResponse(200, response, { 'cache-control': 'public, max-age=30' });
}

/**
 * Historia: `GET /v1/tms/stations/{tmsNumber}/history`.
 *
 * Tyypit:
 *  - `daily` (oletus): vuorokausivolyymit aikaväliltä (`days`, oletus 14)
 *  - `hourly`: tuntijakauma yhdeltä päivältä (`date`, oletus eilen)
 *  - `speed`: kuukauden keskinopeudet suunnittain (`month`, oletus kuluva)
 *  - `all`: kaikki kolme yhdellä vastauksella — **sivun käyttämä tyyppi**,
 *    koska kolme rinnakkaista pyyntöä ehtisi throttlautua kylmällä Lambdalla
 *    (havaittu 27.9.2026: käyttäjä näki 503:n)
 *
 * Kaikki ajat ovat **lähteen omia jaksoja**: "eilen" tarkoittaa viimeistä
 * päättynyttä vuorokautta, joten keskeneräistä päivää ei koskaan näytetä
 * täytenä (malli §20: aikaleimoja ei arvata).
 */
async function handleHistory(
  rawTmsNumber: string,
  query: Record<string, string | undefined>,
): Promise<APIGatewayProxyResultV2> {
  const tmsNumber = parseTmsNumber(rawTmsNumber);
  if (tmsNumber === null) return jsonResponse(400, { error: 'INVALID_TMS_NUMBER' });

  const resolved = resolveHistoryQuery(
    query['type'],
    { days: query['days'], date: query['date'], month: query['month'] },
    Date.now(),
    historyDays,
  );
  if (!resolved.ok) {
    const body: Record<string, unknown> = { error: resolved.error };
    if (resolved.allowed) body['allowed'] = resolved.allowed;
    if (resolved.max !== undefined) body['max'] = resolved.max;
    return jsonResponse(400, body);
  }

  const { type, from, to, date, month } = resolved.query;
  const period =
    type === 'daily'
      ? `${from}..${to}`
      : type === 'hourly'
        ? date
        : type === 'speed'
          ? month
          : `${from}..${to}|${date}|${month}`;
  const cacheKey = `${tmsNumber}:${type}:${period}`;

  try {
    const entry = await historyCache.get(cacheKey, () =>
      loadHistory(tmsNumber, { type, from, to, date, month }),
    );
    return jsonResponse(200, entry.value, { 'cache-control': 'public, max-age=600' });
  } catch (error) {
    logger.error('Historian haku epäonnistui', {
      tmsNumber,
      type,
      cacheKey,
      // Lähteen tilakoodi erottaa "Digitraffic vastasi 4xx/5xx" verkkoviasta.
      upstreamStatus: error instanceof DigitrafficError ? error.status : null,
      error: serializeError(error),
    });
    return jsonResponse(503, { error: 'UPSTREAM_UNAVAILABLE' }, { 'retry-after': '60' });
  }
}

interface HistoryParts {
  type: HistoryType;
  from: string;
  to: string;
  date: string;
  month: string;
}

/** Hakee ja jäsentää yhden tai kaikki historiajaksot Digitrafficilta. */
async function loadHistory(tmsNumber: number, parts: HistoryParts): Promise<HistoryPayload> {
  const fetchedAt = new Date().toISOString();
  // Historia-CSV ei sisällä lähteen aikaleimaa, joten `generatedAt` jää
  // `null`iksi — puuttuva tieto näkyy puuttuvana, ei arvattuna (§20).
  const base = {
    tmsNumber,
    name: knownStationName(tmsNumber),
    generatedAt: null,
    fetchedAt,
    stale: false,
  };

  /** Yksi CSV-haku uusintayrityksellä (lähde on latenssiltaan epävakaa). */
  const csvWithRetry = (query: Record<string, string>): Promise<string> =>
    withRetry(() => fetchHistoryCsv(query, historyTimeoutMs), {
      attempts: historyRetryAttempts,
      backoffMs: historyRetryBackoffMs,
      isRetryable: isRetryableUpstreamError,
      onRetry: (error, attempt) => {
        logger.warn('Historia-CSV:n haku uusitaan', {
          tmsNumber,
          attempt,
          error: serializeError(error),
        });
      },
    });

  const loadDaily = async (): Promise<DailyHistoryResponse> => {
    const csv = await csvWithRetry({
      api: 'liikennemaara',
      ...historyQuery(tmsNumber, 'vrk', parts.from, parts.to),
    });
    return {
      ...base,
      type: 'daily',
      range: { from: parts.from, to: parts.to },
      days: parseDailySeries(csv),
    };
  };

  const loadHourly = async (): Promise<HourlyHistoryResponse> => {
    const csv = await csvWithRetry({
      api: 'liikennemaara',
      ...historyQuery(tmsNumber, 'h', parts.date, ''),
    });
    const { hours, total } = parseHourlySeries(csv);
    return { ...base, type: 'hourly', date: parts.date, hours, total };
  };

  const loadSpeed = async (): Promise<SpeedHistoryResponse> => {
    const csv = await csvWithRetry({
      api: 'keskinopeus',
      ...historyQuery(tmsNumber, 'kk', `${parts.month}-01`, ''),
    });
    return { ...base, type: 'speed', month: parts.month, directions: parseSpeedByDirection(csv) };
  };

  if (parts.type !== 'all') {
    if (parts.type === 'daily') return loadDaily();
    if (parts.type === 'hourly') return loadHourly();
    return loadSpeed();
  }

  // `all`: rinnakkaisuus on Lambdan sisäistä, joten selaimen ei tarvitse tehdä
  // kolmea pyyntöä (ja throttlautua kylmänä). Yhden osan epäonnistuminen ei
  // kaada koko vastausta — se merkitään `partial: true`na ja tyhjänä sarjana,
  // jolloin käyttäjä näkee kaksi muuta kuvaajaa (ja niiden omat "ei tietoja"
  // -tilat puuttuvalle). Sama periaate kuin muualla: puuttuva tieto näkyy
  // puuttuvana, ei virheenä koko sivulle.
  const [daily, hourly, speed] = await Promise.allSettled([loadDaily(), loadHourly(), loadSpeed()]);

  const failures: string[] = [];
  if (daily.status === 'rejected') failures.push('daily');
  if (hourly.status === 'rejected') failures.push('hourly');
  if (speed.status === 'rejected') failures.push('speed');

  if (failures.length === 3) {
    // Kaikki kolme epäonnistuivat → kyse on lähteen katkoksesta, ei yhdestä
    // hitaasta vastauksesta. Silloin virhe nostetaan (→ 503).
    throw (daily as PromiseRejectedResult).reason;
  }

  if (failures.length > 0) {
    logger.warn('Osa historiajaksoista epäonnistui', { tmsNumber, failures });
  }

  return {
    ...base,
    type: 'all',
    partial: failures.length > 0,
    daily: daily.status === 'fulfilled' ? daily.value : emptyDailyHistory(base, parts),
    hourly: hourly.status === 'fulfilled' ? hourly.value : emptyHourlyHistory(base, parts),
    speed: speed.status === 'fulfilled' ? speed.value : emptySpeedHistory(base, parts),
  };
}

/** Tyhjä vuorokausisarja puuttuvan osan tilalle (näytetään "ei tietoja"). */
function emptyDailyHistory(base: HistoryBase, parts: HistoryParts): DailyHistoryResponse {
  return { ...base, type: 'daily', range: { from: parts.from, to: parts.to }, days: [] };
}

function emptyHourlyHistory(base: HistoryBase, parts: HistoryParts): HourlyHistoryResponse {
  return { ...base, type: 'hourly', date: parts.date, hours: [], total: null };
}

function emptySpeedHistory(base: HistoryBase, parts: HistoryParts): SpeedHistoryResponse {
  return { ...base, type: 'speed', month: parts.month, directions: [] };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return withCorrelationId(newCorrelationId(), async () => {
    const path = event.rawPath ?? '';
    const query = event.queryStringParameters ?? {};

    if (path.endsWith('/v1/tms/stations')) return handleStations();

    const match = /^\/v1\/tms\/stations\/([^/]+)\/history$/.exec(path);
    const rawTmsNumber = match?.[1];
    if (rawTmsNumber) return handleHistory(rawTmsNumber, query);

    return jsonResponse(404, { error: 'NOT_FOUND' });
  });
}
